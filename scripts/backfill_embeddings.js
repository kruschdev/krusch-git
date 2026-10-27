#!/usr/bin/env node
/**
 * Backfill missing or stale-model embeddings in kruschdb.blobs.
 * Finds rows where embedding IS NULL (or embed_model differs under --reembed-stale-model)
 * and generates vectors via the Ollama fleet with context-header chunk grounding.
 * 
 * Usage:
 *   node scripts/backfill_embeddings.js                        # Homelab repos only (missing embeddings)
 *   node scripts/backfill_embeddings.js --all                   # All repos including datasets
 *   node scripts/backfill_embeddings.js --project=krusch-git    # Single project
 *   node scripts/backfill_embeddings.js --reembed-stale-model   # Latest blobs missing or != active embed_model
 *   node scripts/backfill_embeddings.js --latest-only           # Deduplicate to newest blob per (repo, file_path)
 */
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import {
    getEmbeddingsBatch,
    getChunkedCentroidEmbedding,
    getActiveEmbedModel,
    formatChunkHeader,
    isEmbeddable,
    MAX_EMBED_CHARS,
    PRIORITY,
    ollamaQueue
} from '../lib/embedding.js';
import { pool } from '../db/pool.js';

// Active homelab projects to include by default (aligned with AGENTS.md & sync_all_projects.js;
// excludes third-party checkouts like vllm / agent-toolkit-for-aws and legacy umbrella 'homelab')
const HOMELAB_REPOS = new Set([
    'annotated', 'ai-watch', 'berean', 'card-game-context', 'caren', 'compass-concierge',
    'first-things-first', 'g-krusch', 'halo', 'heyjb', 'hivemind-companion-ext', 'home-ai',
    'homelab-voice', 'jean-sre', 'krusch', 'krusch-agentic-mcp', 'krusch-agentic-proxy',
    'krusch-authority-packs', 'krusch-biz', 'krusch-bizlaw', 'krusch-cascade-router',
    'krusch-ci-sentinel', 'krusch-companion', 'krusch-companion-skylight-connector',
    'krusch-context-mcp', 'krusch-dev-site', 'krusch-frontend-mcp', 'krusch-fs',
    'krusch-gateway-mcp', 'krusch-git', 'krusch-harness', 'krusch-infra-mcp', 'krusch-law',
    'krusch-nexus', 'krusch-oss', 'krusch-pocketlawyer-mcp', 'krusch-polygres-connector',
    'krusch-pre-router', 'krusch-router', 'krusch-sentinel-mcp', 'krusch-sequential-mcp',
    'krusch-stack', 'kruschdev', 'lightmind', 'money-machine', 'perkins_snow_removal',
    'pg-git', 'pocket-lawyer', 'pocket-lawyer-marketing', 'roughin-suite', 'signet',
    'smart-router-os', 'spark', 'scripts', 'lib', 'lib-py', '.agent'
]);

/**
 * Build the parameterized SQL query and parameter list for selecting blobs to embed/re-embed.
 */
export function buildBackfillQuery({
    allRepos = false,
    projectFilter = null,
    reembedStaleModel = false,
    latestOnly = false,
    activeModel = getActiveEmbedModel()
} = {}) {
    const useLatest = Boolean(latestOnly || reembedStaleModel);
    const params = [];
    let repoClause = '';

    if (projectFilter) {
        params.push(projectFilter);
        repoClause = ` AND r.name = $${params.length}`;
    } else if (!allRepos) {
        params.push([...HOMELAB_REPOS]);
        repoClause = ` AND r.name = ANY($${params.length})`;
    }

    if (!useLatest && !reembedStaleModel) {
        const queryText = `
        SELECT b.id, b.file_name, b.file_path, b.size, b.summary, b.embed_model, r.name as repo_name
        FROM blobs b
        JOIN repositories r ON b.repository_id = r.id
        WHERE b.embedding IS NULL AND b.file_name IS NOT NULL${repoClause}
        ORDER BY b.size ASC`;
        return { queryText, params };
    }

    let targetPredicate = 'b.embedding IS NULL AND b.file_name IS NOT NULL';
    if (reembedStaleModel) {
        params.push(activeModel);
        targetPredicate = `(b.embedding IS NULL OR b.embed_model IS DISTINCT FROM $${params.length}) AND b.file_name IS NOT NULL`;
    }

    const queryText = `
        WITH latest_blobs AS (
            (
                SELECT DISTINCT ON (b.repository_id, b.file_path)
                    b.id,
                    b.repository_id,
                    b.file_name,
                    b.file_path,
                    b.size,
                    b.summary,
                    b.embedding,
                    b.embed_model,
                    r.name AS repo_name
                FROM blobs b
                JOIN repositories r ON b.repository_id = r.id
                WHERE b.file_name IS NOT NULL AND b.file_path IS NOT NULL${repoClause}
                ORDER BY b.repository_id, b.file_path, COALESCE(b.last_seen_at, b.created_at) DESC NULLS LAST, b.id DESC
            )
            UNION ALL
            (
                SELECT
                    b.id,
                    b.repository_id,
                    b.file_name,
                    b.file_path,
                    b.size,
                    b.summary,
                    b.embedding,
                    b.embed_model,
                    r.name AS repo_name
                FROM blobs b
                JOIN repositories r ON b.repository_id = r.id
                WHERE b.file_name IS NOT NULL AND b.file_path IS NULL${repoClause}
            )
        )
        SELECT b.id, b.file_name, b.file_path, b.size, b.summary, b.embed_model, b.repo_name
        FROM latest_blobs b
        WHERE ${targetPredicate}
        ORDER BY b.size ASC`;

    return { queryText, params };
}

export async function main(cliArgs = process.argv.slice(2)) {
    const args = Array.isArray(cliArgs) ? cliArgs : [];
    if (args.includes('--help') || args.includes('-h')) {
        console.log('Usage: node scripts/backfill_embeddings.js [--all] [--project=<repo_name>] [--reembed-stale-model] [--latest-only]');
        process.exit(0);
    }
    const allRepos = args.includes('--all');
    const reembedStaleModel = args.includes('--reembed-stale-model');
    const latestOnly = args.includes('--latest-only') || reembedStaleModel;
    const projectFlag = args.find(a => a.startsWith('--project='));
    const rawProjectFilter = projectFlag ? projectFlag.split('=')[1]?.trim() : null;
    if (projectFlag && (!rawProjectFilter || !/^[a-zA-Z0-9._-]+$/.test(rawProjectFilter))) {
        console.error(`❌ Invalid --project value: "${rawProjectFilter || ''}"`);
        process.exit(1);
    }
    const projectFilter = rawProjectFilter;
    const activeModel = getActiveEmbedModel();

    console.log('PG-Git Embedding Backfill');
    console.log('========================');
    console.log(`Active Model: ${activeModel}`);
    if (projectFilter) console.log(`Filter: project=${projectFilter}`);
    else if (!allRepos) console.log('Filter: homelab repos only (use --all for everything)');
    if (reembedStaleModel) console.log('Mode: --reembed-stale-model (latest blobs missing or != active model)');
    else if (latestOnly) console.log('Mode: --latest-only (latest blobs missing embeddings)');

    const { queryText, params } = buildBackfillQuery({
        allRepos,
        projectFilter,
        reembedStaleModel,
        latestOnly,
        activeModel
    });

    const missing = await pool.query(queryText, params);
    console.log(`Found ${missing.rows.length} blobs ${reembedStaleModel ? 'missing or with stale embeddings' : 'missing embeddings'}.\n`);

    if (missing.rows.length === 0) {
        console.log('Nothing to backfill!');
        await pool.end();
        return;
    }

    let processed = 0;
    let skipped = 0;
    let failed = 0;
    const startTime = Date.now();
    const logInterval = setInterval(() => {
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        const rate = processed > 0 ? (processed / (Date.now() - startTime) * 1000).toFixed(1) : '0';
        console.log(`[${elapsed}s] Embedded: ${processed} | Skipped: ${skipped} | Failed: ${failed} | Rate: ${rate}/s`);
    }, 10_000);

    const projectsRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
    const monorepoRoot = path.resolve(projectsRoot, '..');
    const singlePassLimit = Math.max(1000, (MAX_EMBED_CHARS || 5600) - 200);
    const SINGLE_PASS_BATCH = 32;
    let pendingSinglePass = [];

    const flushSinglePassBatch = async () => {
        if (pendingSinglePass.length === 0) return;
        const batch = pendingSinglePass;
        pendingSinglePass = [];
        const inputs = batch.map((item) => item.inputWithHeader);
        const vectors = await getEmbeddingsBatch(inputs, PRIORITY.LOW, { batchSize: SINGLE_PASS_BATCH });
        for (let i = 0; i < batch.length; i++) {
            const vec = vectors?.[i];
            const row = batch[i].row;
            if (vec && vec.length > 0) {
                const embeddingStr = `[${vec.join(',')}]`;
                await pool.query(
                    'UPDATE blobs SET embedding = $1::vector, embed_model = $2 WHERE id = $3',
                    [embeddingStr, activeModel, row.id]
                );
                processed++;
            } else {
                failed++;
                if (failed <= 5) console.warn(`Failed to embed: ${row.file_path} (${row.repo_name})`);
            }
        }
    };

    for (const row of missing.rows) {
        const ext = path.extname(row.file_name || '').toLowerCase();
        if (!isEmbeddable(ext)) {
            skipped++;
            continue;
        }

        let text = '';
        try {
            const safeRepoName = path.basename(String(row.repo_name || '').trim());
            const cleanRel = String(row.file_path || '').replace(/^[/\\]+/, '');
            if (!safeRepoName || safeRepoName === '.' || safeRepoName === '..' || !cleanRel || cleanRel.includes('\0') || safeRepoName.includes('\0')) {
                throw new Error('Invalid repository or file path');
            }
            const projectBase = path.resolve(projectsRoot, safeRepoName);
            const monorepoBase = path.resolve(monorepoRoot, safeRepoName);

            const readContained = async (baseDir, relPath) => {
                const candidatePath = path.resolve(baseDir, relPath);
                const rel = path.relative(baseDir, candidatePath);
                if (rel.startsWith('..') || path.isAbsolute(rel) || rel === '') {
                    throw new Error('Path traversal blocked');
                }
                const realBase = await fs.realpath(baseDir);
                const realTarget = await fs.realpath(candidatePath);
                const relReal = path.relative(realBase, realTarget);
                if (relReal.startsWith('..') || path.isAbsolute(relReal) || relReal === '') {
                    throw new Error('Symlink path traversal blocked');
                }
                const contentBuffer = await fs.readFile(realTarget);
                return contentBuffer.toString('utf-8');
            };

            try {
                text = await readContained(projectBase, cleanRel);
            } catch (primaryErr) {
                if (process.env.DEBUG_BACKFILL === 'true') {
                    console.warn(`[Backfill] Primary lookup miss for ${cleanRel}: ${primaryErr.message}`);
                }
                text = await readContained(monorepoBase, cleanRel);
            }
        } catch (readErr) {
            if (process.env.DEBUG_BACKFILL === 'true') {
                console.warn(`[Backfill] Falling back to summary for ${row.file_path}: ${readErr.message}`);
            }
            // Fall back to summary if reading file from disk fails
            text = row.summary || '';
        }
        
        if (text.length < 10) {
            skipped++;
            continue;
        }

        // Use batched /api/embed for single-window files and chunked centroid for multi-window files (up to 30,000 chars)
        const textToEmbed = text.substring(0, 30000);
        const contextHeader = formatChunkHeader(row.repo_name, row.file_path);
        const combinedSingle = contextHeader ? `${contextHeader}${textToEmbed}` : textToEmbed;

        if (combinedSingle.length <= singlePassLimit) {
            pendingSinglePass.push({ row, inputWithHeader: combinedSingle });
            if (pendingSinglePass.length >= SINGLE_PASS_BATCH) {
                await flushSinglePassBatch();
            }
            continue;
        }

        await flushSinglePassBatch();
        const vector = await getChunkedCentroidEmbedding(textToEmbed, PRIORITY.LOW, { contextHeader });

        if (vector && vector.length > 0) {
            const embeddingStr = `[${vector.join(',')}]`;
            await pool.query(
                'UPDATE blobs SET embedding = $1::vector, embed_model = $2 WHERE id = $3',
                [embeddingStr, activeModel, row.id]
            );
            processed++;
        } else {
            failed++;
            if (failed <= 5) console.warn(`Failed to embed: ${row.file_path} (${row.repo_name})`);
        }
    }

    await flushSinglePassBatch();

    clearInterval(logInterval);
    const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`\nDone: ${processed} embedded, ${skipped} skipped, ${failed} failed (${totalTime}s)`);
    
    // Print fleet health
    try {
        const health = ollamaQueue.health();
        console.log(`Fleet: ${health.map(h => `${h.endpoint.split('//')[1]} (✓${h.successes}/✗${h.failures})`).join(', ')}`);
    } catch (err) {
        console.warn(`Fleet health telemetry unavailable: ${err.message}`);
    }

    await pool.end();
}

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isDirectRun) {
    main().catch((err) => {
        console.error('Fatal:', err);
        process.exit(1);
    });
}
