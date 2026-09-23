#!/usr/bin/env node
/**
 * Backfill embeddings for external repos that were ingested with raw content
 * but no summary/file_name metadata (e.g. langchain, agent-framework).
 * 
 * Unlike backfill_embeddings.js which reads from `summary`, this reads
 * directly from `content` and uses chunked centroid embedding.
 * 
 * Usage:
 *   node scripts/backfill_external.js --project=langchain
 *   node scripts/backfill_external.js --project=agent-framework
 *   node scripts/backfill_external.js --all-external
 */
import pg from 'pg';
import path from 'path';
import { getChunkedCentroidEmbedding, isEmbeddable } from '../lib/embedding.js';
import { ollamaQueue } from '../lib/embedding.js';

const pool = new pg.Pool({
    host: process.env.DB_HOST || 'localhost',
    port: process.env.DB_PORT || 5434,
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'kruschdb'
});

// External reference repos worth embedding
const EXTERNAL_REPOS = new Set([
    'langchain', 'agent-framework', 'ai-agents-for-beginners',
    'goose-repo', 'generative-ai', 'oracle-ai-developer-hub',
    'openai-cookbook', 'beeai-framework', 'azureai-samples',
    'applied-ai-engineering-samples', 'GenAI_Agents',
    'full-stack-fastapi-template', 'agent-innovator-lab',
    'matlab-agentic-toolkit', 'node-express-boilerplate',
    // JS/TS reference repos (May 2026)
    'langchainjs', 'ai', 'typescript-sdk', 'mcp-servers',
    'mastra', 'langgraphjs', 'openai-node', 'generative-ai-js',
    'LlamaIndexTS', 'voltagent'
]);

// Binary/non-embeddable content heuristics
function isLikelyBinary(content) {
    if (!content || content.length < 20) return true;
    // Check for binary content indicators
    const nullBytes = (content.match(/\0/g) || []).length;
    if (nullBytes > 5) return true;
    // Check for base64 image data
    if (content.startsWith('data:image') || content.startsWith('iVBOR') || content.startsWith('/9j/')) return true;
    // Check for excessively long lines (likely minified/binary)
    const lines = content.split('\n');
    if (lines.length < 3 && content.length > 5000) return true;
    return false;
}

async function main() {
    const args = process.argv.slice(2);
    const projectFlag = args.find(a => a.startsWith('--project='));
    const projectFilter = projectFlag ? projectFlag.split('=')[1] : null;
    const allExternal = args.includes('--all-external');
    const maxSize = parseInt(args.find(a => a.startsWith('--max-size='))?.split('=')[1] || '100000'); // 100KB default

    console.log('PG-Git External Repo Backfill');
    console.log('=============================');
    
    if (!projectFilter && !allExternal) {
        console.log('Usage: --project=NAME or --all-external');
        console.log('Available:', [...EXTERNAL_REPOS].join(', '));
        await pool.end();
        return;
    }

    let queryText = `
        SELECT b.id, b.content, b.size, b.file_name, b.file_path, r.name as repo_name
        FROM blobs b
        JOIN repositories r ON b.repository_id = r.id
        WHERE b.embedding IS NULL 
          AND b.content IS NOT NULL 
          AND b.size < $1
          AND b.size > 20
    `;
    const params = [maxSize];

    if (projectFilter) {
        queryText += ` AND r.name = $2`;
        params.push(projectFilter);
        console.log(`Filter: project=${projectFilter}`);
    } else if (allExternal) {
        queryText += ` AND r.name = ANY($2)`;
        params.push([...EXTERNAL_REPOS]);
        console.log('Filter: all external repos');
    }

    queryText += ` ORDER BY b.size ASC`;

    const missing = await pool.query(queryText, params);
    console.log(`Found ${missing.rows.length} blobs to process.\n`);

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
        const pct = ((processed + skipped + failed) / missing.rows.length * 100).toFixed(1);
        console.log(`[${elapsed}s] Embedded: ${processed} | Skipped: ${skipped} | Failed: ${failed} | Progress: ${pct}% | Rate: ${rate}/s`);
    }, 15_000);

    for (const row of missing.rows) {
        const content = typeof row.content === 'string' ? row.content : row.content.toString('utf-8');

        // Skip binary/non-embeddable content
        if (isLikelyBinary(content)) {
            skipped++;
            continue;
        }

        // Skip translation duplicates for ai-agents-for-beginners
        if (row.repo_name === 'ai-agents-for-beginners' && row.file_path) {
            const fp = row.file_path;
            // Keep only English originals and translations/en — skip other languages
            if (fp.startsWith('translations/') && !fp.startsWith('translations/en/')) {
                skipped++;
                continue;
            }
            if (fp.startsWith('translated_images/')) {
                skipped++;
                continue;
            }
        }

        // Use chunked centroid for quality
        const text = content.substring(0, 20000); // Cap at 20KB to prevent context explosion
        const vector = await getChunkedCentroidEmbedding(text);

        if (vector) {
            const embeddingStr = `[${vector.join(',')}]`;
            await pool.query(
                'UPDATE blobs SET embedding = $1::vector WHERE id = $2',
                [embeddingStr, row.id]
            );
            processed++;
        } else {
            failed++;
            if (failed <= 5) console.warn(`Failed: ${row.file_path || row.file_name || row.id} (${row.repo_name}, ${row.size}B)`);
        }
    }

    clearInterval(logInterval);
    const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`\nDone: ${processed} embedded, ${skipped} skipped, ${failed} failed (${totalTime}s)`);

    // Print fleet health
    try {
        const health = ollamaQueue.health();
        console.log(`Fleet: ${health.map(h => `${h.endpoint.split('//')[1]} (✓${h.successes}/✗${h.failures})`).join(', ')}`);
    } catch (_) { /* queue not initialized */ }

    await pool.end();
}

main().catch(e => {
    console.error('Fatal:', e);
    process.exit(1);
});
