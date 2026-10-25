import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { config } from '../config.js';
import * as git from './git-engine.js';
import { pool } from '../db/pool.js';
import dotenv from 'dotenv';

import { ollamaQueue, getEmbeddingCacheStats } from '../lib/embedding.js';

dotenv.config({ quiet: true });

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();

const allowedOriginsEnv = process.env.CORS_ORIGINS || process.env.CORS_ORIGIN;
const explicitOrigins = allowedOriginsEnv
    ? allowedOriginsEnv.split(',').map(o => o.trim()).filter(Boolean)
    : null;

function isAllowedOrigin(origin) {
    if (!origin) return true;
    if (explicitOrigins) {
        return explicitOrigins.includes('*') || explicitOrigins.includes(origin);
    }
    if (process.env.NODE_ENV === 'production') {
        return false;
    }
    return /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\]|192\.168\.1\.\d+|10\.0\.0\.\d+|10\.10\.10\.\d+|100\.\d+\.\d+\.\d+|([a-z0-9-]+\.)*krusch\.dev)(:\d+)?$/i.test(origin);
}

function isLoopbackAddress(addr) {
    if (!addr) return false;
    return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}

function isAuthorizedWrite(req) {
    const configuredKey = process.env.KRUSCH_GIT_API_KEY || process.env.API_KEY;
    const providedKey = req.headers['x-api-key'] || (req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7).trim() : null);
    if (configuredKey && providedKey) {
        return providedKey === configuredKey;
    }
    if (configuredKey && process.env.REQUIRE_API_KEY_LOCAL === 'true') {
        return false;
    }
    const forwarded = req.headers['x-forwarded-for'];
    if (forwarded) {
        const clientIp = String(forwarded).split(',')[0].trim();
        return isLoopbackAddress(clientIp);
    }
    const remoteAddr = req.socket?.remoteAddress || req.ip || '';
    return isLoopbackAddress(remoteAddr);
}

async function resolveRepoParam(rawRepo) {
    const trimmed = String(rawRepo || '').trim();
    if (!trimmed || trimmed.length > 128 || trimmed.includes('\0') || !/^[a-zA-Z0-9._-]+$/.test(trimmed)) {
        return null;
    }
    if (/^\d+$/.test(trimmed)) {
        const id = parseInt(trimmed, 10);
        const idRes = await pool.query('SELECT id FROM repositories WHERE id = $1 LIMIT 1', [id]);
        return idRes.rows[0]?.id ?? null;
    }
    const repoRes = await pool.query(
        'SELECT id FROM repositories WHERE name = $1 OR name = $2 OR name = $3 LIMIT 1',
        [trimmed, trimmed === 'krusch-git' ? 'pg-git' : trimmed, trimmed.replace(/^krusch-/, '')]
    );
    return repoRes.rows[0]?.id ?? null;
}

// ── Middleware ─────────────────────────────────────────────────────────────────
app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    next();
});
app.use(cors({
    origin: (origin, callback) => {
        callback(null, isAllowedOrigin(origin));
    }
}));
app.use(express.json({ limit: '1mb' }));

// Serve client static assets in production
const clientDist = path.join(__dirname, '..', 'client', 'dist');
app.use(express.static(clientDist));

// ── API Routes ────────────────────────────────────────────────────────────────
app.get('/api/health', async (req, res) => {
    try {
        await pool.query('SELECT 1');
        res.json({
            status: 'ok',
            database: true,
            queue: ollamaQueue.health(),
            embeddingCache: getEmbeddingCacheStats()
        });
    } catch (err) {
        res.status(503).json({
            status: 'degraded',
            database: false,
            error: err.message
        });
    }
});

app.get('/api/config', (req, res) => {
    res.json({ ai: { embedModel: config.ai.embedModel } });
});

app.get('/api/repos', async (req, res, next) => {
    try {
        const repos = await git.getRepositories();
        res.json(repos);
    } catch (err) {
        next(err);
    }
});

app.post('/api/repos', async (req, res, next) => {
    try {
        if (!isAuthorizedWrite(req)) {
            return res.status(403).json({ error: 'Forbidden: loopback connection or valid API key required' });
        }
        const rawName = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
        const description = typeof req.body?.description === 'string' ? req.body.description.trim() : '';
        if (!rawName || rawName.length > 128 || !/^[a-zA-Z0-9._-]+$/.test(rawName) || rawName === '.' || rawName === '..') {
            return res.status(400).json({ error: 'Invalid repository name. Use 1-128 alphanumeric, dot, underscore, or hyphen characters.' });
        }
        const repo = await git.createRepository(rawName, description);
        res.json(repo);
    } catch (err) {
        next(err);
    }
});

app.get('/api/repos/:id/tree', async (req, res, next) => {
    try {
        const repoId = parseInt(req.params.id, 10);
        if (isNaN(repoId) || repoId <= 0) {
            return res.status(400).json({ error: 'Invalid repository ID' });
        }

        // Get root tree for the main branch
        const rootTreeId = await git.getRepoRootTree(repoId);
        if (!rootTreeId) {
            return res.json([]);
        }

        const entries = await git.getTreeEntries(rootTreeId, repoId);
        res.json(entries || []);
    } catch (err) {
        next(err);
    }
});

app.get('/api/repos/:id/tree/:treeId', async (req, res, next) => {
    try {
        const repoId = parseInt(req.params.id, 10);
        if (isNaN(repoId) || repoId <= 0) {
            return res.status(400).json({ error: 'Invalid repository ID' });
        }
        const treeId = String(req.params.treeId || '').trim();
        if (!treeId || treeId.includes('\0') || treeId.length > 64) {
            return res.status(400).json({ error: 'Invalid tree ID' });
        }
        const entries = await git.getTreeEntries(treeId, repoId);
        res.json(entries || []);
    } catch (err) {
        next(err);
    }
});

app.get('/api/blobs/:id', async (req, res, next) => {
    try {
        const blobId = String(req.params.id || '').trim();
        if (!blobId || blobId.includes('\0')) {
            return res.status(400).json({ error: 'Invalid blob ID' });
        }
        const blob = await git.getBlob(blobId);
        if (!blob) {
            return res.status(404).json({ error: 'Blob not found' });
        }
        const buffer = await git.resolveBlobContent(blob);
        let isBinary = false;
        let content = '';
        if (buffer) {
            isBinary = buffer.subarray(0, 1024).includes(0);
            if (isBinary) {
                content = `[Binary file: ${blob.file_name || blob.id} (${buffer.length} bytes)]`;
            } else {
                content = buffer.toString('utf-8');
                if (content.length > 500000) {
                    content = content.slice(0, 500000) + `\n\n... [Content truncated: file size (${buffer.length} bytes) exceeds limit]`;
                }
            }
        } else if (blob.summary) {
            content = blob.summary;
        } else {
            return res.status(404).json({ error: 'Blob content unavailable on disk' });
        }
        res.json({
            id: blob.id,
            size: blob.size,
            file_name: blob.file_name,
            file_path: blob.file_path,
            is_binary: isBinary,
            content
        });
    } catch (err) {
        next(err);
    }
});

app.get('/api/blobs/:id/symbols', async (req, res, next) => {
    try {
        const blobId = String(req.params.id || '').trim();
        if (!blobId || blobId.includes('\0')) {
            return res.status(400).json({ error: 'Invalid blob ID' });
        }
        const symbols = await git.getSymbolsForBlob(blobId);
        res.json(symbols || []);
    } catch (err) {
        next(err);
    }
});

app.get('/api/search', async (req, res, next) => {
    try {
        const queryText = String(req.query.q || '').replace(/\0/g, '').trim().slice(0, 1000);
        if (!queryText) {
            return res.status(400).json({ error: "Query parameter 'q' is required" });
        }
        const searchType = req.query.type || 'hybrid';
        const limit = Math.max(1, Math.min(parseInt(req.query.limit, 10) || 10, 100));

        let repoId = null;
        const rawRepo = req.query.repo ?? req.query.project;
        if (rawRepo !== undefined && String(rawRepo).trim() !== '') {
            repoId = await resolveRepoParam(rawRepo);
            if (!repoId) {
                const safeRepoLabel = String(rawRepo).replace(/[^a-zA-Z0-9._-]/g, '').slice(0, 64);
                return res.status(404).json({ error: `Repository '${safeRepoLabel}' not found` });
            }
        }

        const results = await git.searchBlobs(queryText, limit, repoId, { search_type: searchType });
        res.json(results || []);
    } catch (err) {
        if (err instanceof TypeError) {
            return res.status(400).json({ status: 400, error: err.message });
        }
        next(err);
    }
});

app.get('/api/symbols', async (req, res, next) => {
    try {
        const queryText = String(req.query.q || '').replace(/\0/g, '').trim().slice(0, 1000);
        if (!queryText) {
            return res.status(400).json({ error: "Query parameter 'q' is required" });
        }
        const limit = Math.max(1, Math.min(parseInt(req.query.limit, 10) || 10, 100));
        const symbolType = req.query.type || req.query.symbol_type || null;

        let repoId = null;
        const rawRepo = req.query.repo ?? req.query.project;
        if (rawRepo !== undefined && String(rawRepo).trim() !== '') {
            repoId = await resolveRepoParam(rawRepo);
            if (!repoId) {
                const safeRepoLabel = String(rawRepo).replace(/[^a-zA-Z0-9._-]/g, '').slice(0, 64);
                return res.status(404).json({ error: `Repository '${safeRepoLabel}' not found` });
            }
        }

        const results = await git.searchSymbols(queryText, limit, repoId, { symbol_type: symbolType });
        res.json(results || []);
    } catch (err) {
        next(err);
    }
});

app.get('/api/graph', async (req, res, next) => {
    try {
        const fileParam = req.query.file ? String(req.query.file).replace(/\0/g, '').trim().replace(/^[/\\]+/, '').slice(0, 512) : null;
        const symbolParam = req.query.symbol ? String(req.query.symbol).replace(/\0/g, '').trim().slice(0, 256) : null;

        if (!fileParam && !symbolParam) {
            return res.status(400).json({ error: "Either 'file' or 'symbol' query parameter is required" });
        }

        let repoId = null;
        const rawRepo = req.query.repo ?? req.query.project;
        if (rawRepo !== undefined && String(rawRepo).trim() !== '') {
            repoId = await resolveRepoParam(rawRepo);
            if (!repoId) {
                const safeRepoLabel = String(rawRepo).replace(/[^a-zA-Z0-9._-]/g, '').slice(0, 64);
                return res.status(404).json({ error: `Repository '${safeRepoLabel}' not found` });
            }
        }

        let targetFilePath = fileParam;
        if (!targetFilePath && symbolParam) {
            const symRes = await pool.query(
                `SELECT file_path, repository_id FROM code_symbols 
                 WHERE symbol_name = $1 ${repoId ? 'AND repository_id = $2' : ''} 
                 ORDER BY id DESC LIMIT 1`,
                repoId ? [symbolParam, repoId] : [symbolParam]
            );
            if (symRes.rows.length > 0) {
                targetFilePath = symRes.rows[0].file_path;
                if (!repoId) repoId = symRes.rows[0].repository_id;
            } else {
                return res.status(404).json({ error: `Symbol '${symbolParam}' not found in indexed repositories` });
            }
        }

        if (!repoId) {
            return res.status(400).json({ error: "Repository context required to resolve dependency graph" });
        }

        const graph = await git.getSymbolGraph(targetFilePath, repoId);
        res.json(graph);
    } catch (err) {
        next(err);
    }
});


// SPA fallback — serve index.html for all non-API routes
app.use((req, res, next) => {
    if (req.path.startsWith('/api/')) {
        return res.status(404).json({ error: 'Not found' });
    }
    res.sendFile(path.join(clientDist, 'index.html'));
});

app.use((err, req, res, _next) => {
    console.error('[pg-git] Internal API error:', err);
    res.status(500).json({ error: 'Internal server error' });
});

// ── Lifecycle ─────────────────────────────────────────────────────────────────
async function verifyDatabase(retries = 3, delayMs = 1000) {
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            await pool.query('SELECT 1');
            console.log('[pg-git] Database connection verified.');
            return true;
        } catch (err) {
            console.warn(`[pg-git] Database connection attempt ${attempt}/${retries} failed: ${err.message}`);
            if (attempt < retries) {
                await new Promise(r => setTimeout(r, delayMs * attempt));
            }
        }
    }
    console.error('[pg-git] WARNING: Cannot reach PostgreSQL on startup. HTTP server will start in degraded mode.');
    return false;
}

let httpServer;

async function shutdown() {
    console.log('[pg-git] Shutting down...');
    if (httpServer) httpServer.close();
    try { await pool.end(); } catch (_) { /* best-effort */ }
    process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

async function main() {
    await verifyDatabase();
    httpServer = app.listen(config.server.port, () => {
        console.log(`PG-Git API running on port ${config.server.port}`);
    });
}

export { app };

const isMain = process.argv[1] && (path.resolve(process.argv[1]) === fileURLToPath(import.meta.url));
if (isMain) {
    main();
}
