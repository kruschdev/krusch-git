#!/usr/bin/env node

import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import crypto from 'crypto';
import { query, pool } from '../db/pool.js';
import { hashContent } from '../server/git-engine.js';
import { getEmbedding, getEmbeddingsBatch, getChunkedCentroidEmbedding, isEmbeddable, MAX_EMBED_CHARS, ollamaQueue, PRIORITY } from '../lib/embedding.js';
import { extractSymbolsAndImports, extractCompactSymbolTokens, computeSymbolHash } from '../lib/ast-chunker.js';
import { resolveSummaryModel } from '../config/ollama.js';

const EXCLUDED_DIRS = new Set(['.git', 'node_modules', 'dist', 'dist-ext', 'build', '__pycache__', 'data', 'tmp', '.gemini', '.venv', 'venv', 'bench_venv', 'mcp_env', '.vscode', 'nodes', 'sandbox', 'logs', 'sandbox-audits', 'scratch', 'mnt', '.agent', '.turbo', '.next', 'out', '.nyc_output', '.source', 'public', 'r', 'kaggle_games_our']);

/** Max file size for non-embeddable files (skip large binaries like .zip entirely) */
const MAX_BINARY_SIZE = 100 * 1024; // 100KB
/** Max file size for embeddable text files (skip massive minified bundles) */
const MAX_EMBEDDABLE_SIZE = 500 * 1024; // 500KB

export function createSyncProgress() {
    return { processed: 0, total: 0, embedded: 0, skipped: 0, symbols: 0, edges: 0 };
}


async function generateInlineSummary(text, fileName) {
    const defaultSummary = text.substring(0, 500);
    if (process.env.SKIP_LLM_SUMMARY === 'true') {
        return defaultSummary;
    }
    if (text.length < 50) return defaultSummary; // Too short for LLM
    try {
        const prompt = `Provide a concise 1-line summary of what this code does. Respond ONLY with the summary.\n\nFile: ${fileName}\n\nCode:\n${text.substring(0, 3000)}`;
        const targetModel = resolveSummaryModel();
        
        const makeRequest = async (host) => {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 15000); // 15s timeout
            try {
                const response = await fetch(`${host}/api/generate`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        model: targetModel,
                        prompt: prompt,
                        stream: false,
                        keep_alive: -1,
                        options: { num_ctx: 16384, num_predict: 80 }
                    }),
                    signal: controller.signal
                });
                if (response.ok) {
                    const data = await response.json();
                    const summaryText = data.response.trim();
                    if (summaryText && summaryText.length > 5) {
                        return summaryText.substring(0, 500); // safety truncation
                    }
                } else {
                    console.warn(`[Summary] Non-OK HTTP ${response.status} from ${host} for ${fileName}, falling back to default summary.`);
                }
                return defaultSummary;
            } catch (err) {
                console.warn(`[Summary] Request to ${host} failed for ${fileName}: ${err.message}`);
                return defaultSummary;
            } finally {
                clearTimeout(timeout);
            }
        };

        if (process.env.OLLAMA_SUMMARY_HOST) {
            return await makeRequest(process.env.OLLAMA_SUMMARY_HOST);
        } else {
            return await ollamaQueue.enqueue(async (endpoint) => {
                return await makeRequest(endpoint);
            }, PRIORITY.LOW);
        }
    } catch (e) {
        console.error(`[Summary] Failed for ${fileName}, falling back to substring. Error: ${e.message}`);
        return defaultSummary;
    }
}

/**
 * Extract AST symbols and import edges for a blob and persist them transactionally.
 * Error-handling policy (BUG-01 / DOC-01):
 * - On any extraction or SQL failure, the active client transaction is rolled back (`ROLLBACK`)
 *   so partial symbol/edge state is never committed.
 * - The error is logged via `console.error` and re-thrown to the caller so snapshot failures
 *   are surfaced rather than silently swallowed.
 */
export async function populateSymbolsAndEdges(sha, repoId, buffer, relativePath, ext, options = {}) {
    if (!isEmbeddable(ext)) return;
    const activePool = options.poolImpl || pool;
    const extractFn = options.extractFn || extractSymbolsAndImports;
    const embedBatchFn = options.embedBatchFn || getEmbeddingsBatch;
    const progress = options.progress || createSyncProgress();
    const shouldEmbedSymbols = options.embedSymbols === true || process.env.EMBED_CODE_SYMBOLS === 'true';
    const client = await activePool.connect();
    try {
        const text = buffer.toString('utf-8');
        const { symbols, imports } = extractFn(text, relativePath);
        
        await client.query('BEGIN');
        // Always purge stale symbols & edges scoped strictly to this repository
        await client.query(`DELETE FROM code_symbols WHERE repository_id = $2 AND (blob_id = $1 OR file_path = $3)`, [sha, repoId, relativePath]);
        await client.query(`DELETE FROM code_symbol_edges WHERE repository_id = $2 AND (source_blob_id = $1 OR source_path = $3)`, [sha, repoId, relativePath]);

        if (symbols && symbols.length > 0) {
            const usePointerTokens = process.env.SYMBOL_STORAGE_MODE !== 'full';
            const BATCH_SIZE = 50;
            for (let i = 0; i < symbols.length; i += BATCH_SIZE) {
                const batch = symbols.slice(i, i + BATCH_SIZE);
                const values = [];
                const params = [];
                let pIdx = 1;

                if (shouldEmbedSymbols) {
                    const symbolInputs = batch.map(
                        (sym) => `${relativePath} :: ${sym.type} ${sym.name}\n${sym.signature || ''}\n${(sym.content || '').slice(0, 950)}`
                    );
                    const symbolVectors = await embedBatchFn(symbolInputs, PRIORITY.LOW);
                    for (let sIdx = 0; sIdx < batch.length; sIdx++) {
                        const sym = batch[sIdx];
                        const storedContent = usePointerTokens
                            ? `[POINTER_TOKENS]\n${extractCompactSymbolTokens(sym.content, sym.signature)}`
                            : sym.content;
                        const symHash = sym.symbol_hash || sym.symbolHash || computeSymbolHash(sym.content || sym.signature || sym.name);
                        const vec = symbolVectors?.[sIdx];
                        const vecStr = Array.isArray(vec) && vec.length > 0 ? `[${vec.join(',')}]` : null;
                        values.push(`($${pIdx}, $${pIdx+1}, $${pIdx+2}, $${pIdx+3}, $${pIdx+4}, $${pIdx+5}, $${pIdx+6}, $${pIdx+7}, $${pIdx+8}, $${pIdx+9}, $${pIdx+10}::vector)`);
                        params.push(sha, repoId, relativePath, sym.name, sym.type, sym.startLine, sym.endLine, sym.signature, storedContent, symHash, vecStr);
                        pIdx += 11;
                    }
                    await client.query(`
                        INSERT INTO code_symbols (blob_id, repository_id, file_path, symbol_name, symbol_type, start_line, end_line, signature, content, symbol_hash, embedding)
                        VALUES ${values.join(', ')}
                    `, params);
                } else {
                    for (const sym of batch) {
                        const storedContent = usePointerTokens
                            ? `[POINTER_TOKENS]\n${extractCompactSymbolTokens(sym.content, sym.signature)}`
                            : sym.content;
                        const symHash = sym.symbol_hash || sym.symbolHash || computeSymbolHash(sym.content || sym.signature || sym.name);
                        values.push(`($${pIdx}, $${pIdx+1}, $${pIdx+2}, $${pIdx+3}, $${pIdx+4}, $${pIdx+5}, $${pIdx+6}, $${pIdx+7}, $${pIdx+8}, $${pIdx+9})`);
                        params.push(sha, repoId, relativePath, sym.name, sym.type, sym.startLine, sym.endLine, sym.signature, storedContent, symHash);
                        pIdx += 10;
                    }
                    await client.query(`
                        INSERT INTO code_symbols (blob_id, repository_id, file_path, symbol_name, symbol_type, start_line, end_line, signature, content, symbol_hash)
                        VALUES ${values.join(', ')}
                    `, params);
                }
            }
        }

        if (imports && imports.length > 0) {
            const BATCH_SIZE = 50;
            for (let i = 0; i < imports.length; i += BATCH_SIZE) {
                const batch = imports.slice(i, i + BATCH_SIZE);
                const values = [];
                const params = [];
                let pIdx = 1;
                for (const imp of batch) {
                    values.push(`($${pIdx}, $${pIdx+1}, $${pIdx+2}, $${pIdx+3}, $${pIdx+4}, $${pIdx+5})`);
                    params.push(repoId, sha, relativePath, imp.targetPath, imp.relation, imp.symbols);
                    pIdx += 6;
                }
                await client.query(`
                    INSERT INTO code_symbol_edges (repository_id, source_blob_id, source_path, target_path, relation, symbols)
                    VALUES ${values.join(', ')}
                `, params);
            }
        }

        await client.query('COMMIT');
        progress.symbols += symbols ? symbols.length : 0;
        progress.edges += imports ? imports.length : 0;
    } catch (err) {
        try {
            await client.query('ROLLBACK');
        } catch (rollbackErr) {
            console.error(`[Symbols] Rollback failed for ${relativePath}: ${rollbackErr.message}`);
        }
        console.error(`[Symbols] Failed extracting symbols for ${relativePath}: ${err.message}`);
        throw err;
    } finally {
        client.release();
    }
}

async function insertBlob(repoId, buffer, filePath, rootDir, progress = createSyncProgress()) {
    if (!Buffer.isBuffer(buffer) || !filePath || typeof filePath !== 'string' || filePath.includes('\0')) {
        throw new Error(`Invalid buffer or filePath passed to insertBlob: ${String(filePath)}`);
    }
    const sha = hashContent(buffer);
    const ext = path.extname(filePath).toLowerCase();
    const fileName = path.basename(filePath);
    const relativePath = path.relative(rootDir, filePath);
    
    // Check if the blob already exists to avoid re-embedding
    const existing = await query(`SELECT id, embedding FROM blobs WHERE id = $1`, [sha]);
    if (existing.rows.length > 0) {
        await query(`UPDATE blobs SET last_seen_at = CURRENT_TIMESTAMP, file_name = COALESCE(file_name, $2), file_path = COALESCE(file_path, $3) WHERE id = $1`, [sha, fileName, relativePath]);
        
        // Refresh symbols if missing, if symbol_hash is missing, if EMBED_CODE_SYMBOLS=true and embedding is missing, or if single-line brace bug exists
        const shouldEmbedSymbols = process.env.EMBED_CODE_SYMBOLS === 'true';
        const symCheck = await query(
            shouldEmbedSymbols
                ? `
            SELECT count(*)::int AS cnt,
                   count(*) FILTER (WHERE symbol_hash IS NULL OR embedding IS NULL OR (symbol_type IN ('function', 'class', 'method') AND start_line = end_line))::int AS stale_cnt
            FROM code_symbols
            WHERE blob_id = $1 AND repository_id = $2 AND file_path = $3
        `
                : `
            SELECT count(*)::int AS cnt,
                   count(*) FILTER (WHERE symbol_hash IS NULL OR (symbol_type IN ('function', 'class', 'method') AND start_line = end_line))::int AS stale_cnt
            FROM code_symbols
            WHERE blob_id = $1 AND repository_id = $2 AND file_path = $3
        `,
            [sha, repoId, relativePath]
        );
        if (symCheck.rows[0].cnt === 0 || symCheck.rows[0].stale_cnt > 0) {
            await populateSymbolsAndEdges(sha, repoId, buffer, relativePath, ext, { progress });
        }

        if (existing.rows[0].embedding !== null) {
            return sha;
        }
        // If it exists but embedding is null, we fall through to embed it.
    }

    let embeddingStr = null;
    let summary = null;
    if (isEmbeddable(ext)) {
        const text = buffer.toString('utf-8');
        // Generate summary inline using LLM, fallback to substring
        summary = await generateInlineSummary(text, fileName);
        console.log(`[Embed] Generating semantic vector for: ${path.basename(filePath)}`);
        // Embed up to 30,000 characters to prevent endless loops on massive minified files
        const textToEmbed = text.substring(0, 30000);
        const vector = await getChunkedCentroidEmbedding(textToEmbed);
        if (vector && vector.length > 0) {
            embeddingStr = `[${vector.join(',')}]`;
        }
    }

    // Pointer-based storage: summary + file_path, no full content
    if (embeddingStr) {
        await query(
            `INSERT INTO blobs (id, repository_id, size, embedding, file_name, file_path, summary, storage_mode) VALUES ($1, $2, $3, $4::vector, $5, $6, $7, 'pointer') ON CONFLICT (id) DO UPDATE SET embedding = EXCLUDED.embedding, file_name = EXCLUDED.file_name, file_path = EXCLUDED.file_path, last_seen_at = CURRENT_TIMESTAMP`,
            [sha, repoId, buffer.length, embeddingStr, fileName, relativePath, summary]
        );
        progress.embedded++;
    } else {
        await query(
            `INSERT INTO blobs (id, repository_id, size, file_name, file_path, summary, storage_mode) VALUES ($1, $2, $3, $4, $5, $6, 'pointer') ON CONFLICT (id) DO UPDATE SET file_name = EXCLUDED.file_name, file_path = EXCLUDED.file_path, last_seen_at = CURRENT_TIMESTAMP`,
            [sha, repoId, buffer.length, fileName, relativePath, summary]
        );
    }

    // Populate code symbols & dependency edges
    await populateSymbolsAndEdges(sha, repoId, buffer, relativePath, ext, { progress });

    return sha;
}


function hashTree(entries) {
    // Standardize sorting by name
    entries.sort((a, b) => a.name.localeCompare(b.name));
    const content = entries.map(e => `${e.type} ${e.object_id} ${e.name}`).join('\n');
    return crypto.createHash('sha1').update(`tree ${content.length}\0${content}`).digest('hex');
}

async function processDirectory(dirPath, repoId, rootDir, progress = createSyncProgress()) {
    const resolvedDir = path.resolve(String(dirPath || ''));
    const resolvedRoot = path.resolve(String(rootDir || ''));
    if (resolvedDir !== resolvedRoot && !resolvedDir.startsWith(resolvedRoot + path.sep)) {
        throw new Error(`Path traversal blocked in processDirectory: ${dirPath} is outside ${rootDir}`);
    }
    const items = await fs.readdir(resolvedDir, { withFileTypes: true });
    const entries = [];

    for (const item of items) {
        if (EXCLUDED_DIRS.has(item.name)) continue;
        
        const nameLower = item.name.toLowerCase();
        if (nameLower.includes('venv') || 
            nameLower === 'site-packages' || 
            nameLower.includes('dist-info') || 
            nameLower.includes('egg-info') ||
            nameLower === '.pytest_cache' ||
            nameLower === '.cache') {
            continue;
        }
        
        const fullPath = path.join(dirPath, item.name);
        const relPath = path.relative(rootDir, fullPath);
        
        // Exclude large archives, reference checkouts, and giant third-party codebases to prevent scanning bloat
        const pathsToExclude = [
            'docs/projects',
            'projects/archive',
            'projects/reference',
            'projects/vllm',
            'projects/vllm-hermes',
            'projects/TheAgentCompany',
            'projects/agent-toolkit-for-aws',
            'projects/Brain3',
            'projects/searxng',
            'projects/dbos-worker'
        ];
        if (pathsToExclude.some(p => relPath === p || relPath.startsWith(p + '/'))) {
            continue;
        }
        if (item.isDirectory()) {
            const treeSha = await processDirectory(fullPath, repoId, rootDir, progress);
            if (treeSha) {
                entries.push({ type: 'tree', name: item.name, object_id: treeSha });
            }
        } else {
            let stat;
            try {
                stat = await fs.stat(fullPath);
            } catch (e) {
                if (e.code === 'ENOENT') {
                    console.log(`[Skip] Broken link or missing file: ${fullPath}`);
                    continue;
                }
                throw e;
            }
            if (stat.isDirectory()) {
                continue;
            }
            
            const ext = path.extname(item.name).toLowerCase();
            const embeddable = isEmbeddable(ext);

            // Skip files with heavy inline SVGs or minified structures that crash llama.cpp (GGML_ASSERT)
            const crashyFiles = new Set(['icons.tsx', 'open-in-chat.tsx', 'docs-copy-page.tsx', 'ai-sdk-agents-patterns.tsx', 'blocks-grid.tsx', 'home-below-hero-layouts.tsx', 'components.json', 'package-lock.json', 'ai-instructions-demo.json', 'ai-instructions.json', 'colors.ts', 'blocks.ts']);
            if (crashyFiles.has(item.name)) {
                progress.skipped++;
                console.log(`[Skip] Skipping SVG-heavy or crashy file: ${path.relative(rootDir, fullPath)}`);
                continue;
            }
            
            // Skip large binary files entirely (they bloat the DB without providing search value)
            if (!embeddable && stat.size > MAX_BINARY_SIZE) {
                progress.skipped++;
                continue;
            }
            
            // Skip massive text files (minified bundles, huge generated code)
            if (embeddable && stat.size > MAX_EMBEDDABLE_SIZE) {
                progress.skipped++;
                console.log(`[Skip] Large text file: ${path.relative(rootDir, fullPath)} (${Math.round(stat.size/1024)}KB)`);
                continue;
            }
            
            // General hard cap: no file over 50MB
            if (stat.size > 50 * 1024 * 1024) {
                progress.skipped++;
                continue;
            }
            
            const buffer = await fs.readFile(fullPath);
            const blobSha = await insertBlob(repoId, buffer, fullPath, rootDir, progress);
            entries.push({ type: 'blob', name: item.name, object_id: blobSha });
            
            progress.processed++;
            if (progress.processed % 100 === 0) {
                console.log(`[Progress] ${progress.processed} files processed, ${progress.embedded} embedded, ${progress.skipped} skipped`);
            }
        }
    }

    if (entries.length === 0) return null;

    const treeSha = hashTree(entries);
    
    // Insert Tree if not exists
    await query(`INSERT INTO trees (id, repository_id) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING`, [treeSha, repoId]);
    
    // Batch-insert tree entries using multi-row VALUES
    const BATCH_SIZE = 100;
    for (let i = 0; i < entries.length; i += BATCH_SIZE) {
        const batch = entries.slice(i, i + BATCH_SIZE);
        const values = [];
        const params = [];
        let pIdx = 1;
        for (const entry of batch) {
            values.push(`($${pIdx}, $${pIdx+1}, $${pIdx+2}, $${pIdx+3})`);
            params.push(treeSha, entry.type, entry.name, entry.object_id);
            pIdx += 4;
        }
        await query(
            `INSERT INTO tree_entries (tree_id, type, name, object_id) VALUES ${values.join(', ')} ON CONFLICT (tree_id, name) DO NOTHING`,
            params
        );
    }

    return treeSha;
}

async function main() {
    const rawArg = process.argv[2];
    if (rawArg === '--help' || rawArg === '-h') {
        console.log(`
Usage: node scripts/sync_to_pg.js [target_directory]

Options:
  --help, -h       Show this help message

Environment Variables:
  SKIP_LLM_SUMMARY Set to 'true' to disable Ollama LLM summary generation
  DATABASE_URL     PostgreSQL connection URL
`);
        process.exit(0);
    }

    const targetDir = rawArg ? path.resolve(rawArg) : process.cwd();
    if (!fsSync.existsSync(targetDir)) {
        console.error(`❌ Error: Target directory does not exist: ${targetDir}`);
        process.exit(1);
    }
    const stat = fsSync.statSync(targetDir);
    if (!stat.isDirectory()) {
        console.error(`❌ Error: Target path is not a directory: ${targetDir}`);
        process.exit(1);
    }
    const repoName = path.basename(targetDir);
    
    const progress = createSyncProgress();
    console.log(`Starting Semantic PG-Git Snapshot for: ${repoName}`);
    console.log(`Target Directory: ${targetDir}`);
    console.log(`LLM Summary Generation: ${process.env.SKIP_LLM_SUMMARY === 'true' ? 'DISABLED (avoid VRAM thrashing)' : 'ENABLED'}`);

    // Get or Create Repo
    let repoId;
    const res = await query(`SELECT id FROM repositories WHERE name = $1`, [repoName]);
    if (res.rows.length > 0) {
        repoId = res.rows[0].id;
    } else {
        const inserted = await query(`INSERT INTO repositories (name, description) VALUES ($1, $2) RETURNING id`, [repoName, `Automated snapshot of ${repoName}`]);
        repoId = inserted.rows[0].id;
    }
    console.log(`[Repo Debug] Resolved repository ID for ${repoName}:`, repoId, `type: ${typeof repoId}`);

    // Process Tree
    const rootTreeSha = await processDirectory(targetDir, repoId, targetDir, progress);
    if (!rootTreeSha) {
        console.log('Directory is empty or all ignored.');
        await pool.end();
        return;
    }

    // Create Commit
    const commitMessage = `Automated snapshot at ${new Date().toISOString()}`;
    const commitContent = `tree ${rootTreeSha}\nmessage ${commitMessage}`;
    const commitSha = crypto.createHash('sha1').update(`commit ${commitContent.length}\0${commitContent}`).digest('hex');

    // Get parent commit if exists
    let parentId = null;
    const branchRes = await query(`SELECT commit_id FROM branches WHERE repository_id = $1 AND name = 'main'`, [repoId]);
    if (branchRes.rows.length > 0) {
        parentId = branchRes.rows[0].commit_id;
    }

    // Skip if nothing changed (assuming root tree is same as parent's root tree)
    if (parentId) {
        const parentRes = await query(`SELECT tree_id FROM commits WHERE id = $1`, [parentId]);
        if (parentRes.rows.length > 0 && parentRes.rows[0].tree_id === rootTreeSha) {
            console.log('No changes detected since last snapshot. Skipping commit.');
            await pool.end();
            return;
        }
    }

    await query(
        `INSERT INTO commits (id, repository_id, tree_id, parent_id, message, author) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (id) DO NOTHING`,
        [commitSha, repoId, rootTreeSha, parentId, commitMessage, 'Semantic-Agent']
    );

    // Update branch
    if (parentId) {
        await query(`UPDATE branches SET commit_id = $1 WHERE repository_id = $2 AND name = 'main'`, [commitSha, repoId]);
    } else {
        await query(`INSERT INTO branches (repository_id, name, commit_id) VALUES ($1, $2, $3)`, [repoId, 'main', commitSha]);
    }

    console.log(`✅ Snapshot complete! Commit SHA: ${commitSha}`);
    console.log(`   Files: ${progress.processed} processed, ${progress.embedded} embedded, ${progress.symbols} symbols, ${progress.edges} edges, ${progress.skipped} skipped`);
    
    // Log fleet health if available
    try {
        const health = ollamaQueue.health();
        console.log(`   Fleet: ${health.map(h => `${h.endpoint.split('//')[1]} (✓${h.successes}/✗${h.failures})`).join(', ')}`);
    } catch (_) { /* queue may not be initialized */ }
    
    await pool.end();
}

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);
if (isDirectRun) {
    main().catch(err => {
        console.error('Fatal Error:', err);
        process.exit(1);
    });
}
