#!/usr/bin/env node
/**
 * Generate summaries and tags for external repo blobs using a local LLM.
 * Runs on kruschgame's RTX 3050 (qwen2.5-coder:1.5b) to avoid competing
 * with the embedding backfill on kruschdev/kruschserv.
 *
 * Usage:
 *   node scripts/generate_tags.js --all-external
 *   node scripts/generate_tags.js --project=langchainjs
 *   node scripts/generate_tags.js --project=ai --limit=500
 */
import pg from 'pg';
import 'dotenv/config';

const OLLAMA_HOST = process.env.TAG_OLLAMA_HOST || 'http://10.0.0.19:11434';
const MODEL = process.env.TAG_MODEL || 'qwen2.5-coder:1.5b';
const CONCURRENCY = parseInt(process.env.TAG_CONCURRENCY || '2');

const pool = new pg.Pool({
    host: process.env.DB_HOST || 'localhost',
    port: process.env.DB_PORT || 5434,
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'kruschdb'
});

// Repos that benefit from tagging
const EXTERNAL_REPOS = new Set([
    'langchainjs', 'ai', 'typescript-sdk', 'mcp-servers',
    'mastra', 'langgraphjs', 'openai-node', 'generative-ai-js',
    'LlamaIndexTS', 'voltagent',
    'langchain', 'agent-framework', 'ai-agents-for-beginners',
    'goose-repo', 'generative-ai', 'openai-cookbook',
    'beeai-framework', 'GenAI_Agents'
]);

const SYSTEM_PROMPT = `You are a code librarian. Given a source code file, output a JSON object with:
- "summary": A single sentence (max 120 chars) describing what this file does. Be specific about the technology, pattern, or feature.
- "tags": An array of 3-5 lowercase tags categorizing the file (e.g. "streaming", "agent", "tool-calling", "rag", "vector-store", "middleware", "test", "config", "react", "express").

Rules:
- Summary must be actionable and specific (not "This file contains code")
- Tags should help a developer find this file when searching for patterns
- Output ONLY valid JSON, no markdown fences, no explanation

Example output:
{"summary":"Express middleware for JWT authentication with role-based access control","tags":["auth","jwt","middleware","express","rbac"]}`;

/**
 * Call Ollama generate endpoint for a tagging request
 */
async function generateTags(content, fileName) {
    const truncated = content.substring(0, 4000); // Stay well within 1.5b context
    const prompt = `File: ${fileName}\n\n${truncated}`;

    try {
        const resp = await fetch(`${OLLAMA_HOST}/api/generate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: MODEL,
                system: SYSTEM_PROMPT,
                prompt,
                stream: false,
                options: {
                    temperature: 0.1,
                    num_predict: 200,
                    top_p: 0.9
                }
            })
        });

        if (!resp.ok) {
            const err = await resp.text();
            throw new Error(`Ollama ${resp.status}: ${err}`);
        }

        const data = await resp.json();
        const raw = data.response?.trim();
        if (!raw) return null;

        // Parse JSON — handle common LLM quirks
        let cleaned = raw;
        // Strip markdown fences if present
        cleaned = cleaned.replace(/^```json?\s*/i, '').replace(/\s*```$/i, '');
        // Strip trailing text after the JSON
        const lastBrace = cleaned.lastIndexOf('}');
        if (lastBrace > 0) cleaned = cleaned.substring(0, lastBrace + 1);

        const parsed = JSON.parse(cleaned);
        if (!parsed.summary || !Array.isArray(parsed.tags)) return null;

        return {
            summary: String(parsed.summary).substring(0, 200),
            tags: parsed.tags.slice(0, 8).map(t => String(t).toLowerCase().substring(0, 30))
        };
    } catch (e) {
        if (e instanceof SyntaxError) return null; // JSON parse failure — skip
        throw e;
    }
}

/**
 * Process blobs in batches with concurrency control
 */
async function processBatch(blobs) {
    let processed = 0;
    let skipped = 0;
    let failed = 0;
    const startTime = Date.now();

    const logInterval = setInterval(() => {
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        const rate = processed > 0 ? (processed / (Date.now() - startTime) * 1000).toFixed(2) : '0';
        const pct = ((processed + skipped + failed) / blobs.length * 100).toFixed(1);
        console.log(`[${elapsed}s] Tagged: ${processed} | Skipped: ${skipped} | Failed: ${failed} | Progress: ${pct}% | Rate: ${rate}/s`);
    }, 30_000);

    // Process with concurrency limiter
    const queue = [...blobs];
    const workers = Array.from({ length: CONCURRENCY }, async () => {
        while (queue.length > 0) {
            const blob = queue.shift();
            if (!blob) break;

            const content = typeof blob.content === 'string' 
                ? blob.content 
                : blob.content?.toString('utf-8');

            if (!content || content.length < 30) {
                skipped++;
                continue;
            }

            // Skip binary-looking content
            if (/[\x00-\x08\x0e-\x1f]/.test(content.substring(0, 200))) {
                skipped++;
                continue;
            }

            try {
                const result = await generateTags(content, blob.file_name || 'unknown');
                if (result) {
                    await pool.query(
                        `UPDATE blobs SET summary = $1 WHERE id = $2 AND summary IS NULL`,
                        [result.summary, blob.id]
                    );
                    // Store tags as a JSON comment in summary for now
                    // Future: dedicated tags column
                    const taggedSummary = `${result.summary} [${result.tags.join(', ')}]`;
                    await pool.query(
                        `UPDATE blobs SET summary = $1 WHERE id = $2`,
                        [taggedSummary, blob.id]
                    );
                    processed++;
                } else {
                    failed++;
                }
            } catch (e) {
                failed++;
                if (failed <= 5) console.warn(`Error on ${blob.file_name}: ${e.message}`);
            }
        }
    });

    await Promise.all(workers);
    clearInterval(logInterval);

    const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`\nDone: ${processed} tagged, ${skipped} skipped, ${failed} failed (${totalTime}s)`);
    return { processed, skipped, failed };
}

async function main() {
    const args = process.argv.slice(2);
    const projectFlag = args.find(a => a.startsWith('--project='));
    const projectFilter = projectFlag ? projectFlag.split('=')[1] : null;
    const allExternal = args.includes('--all-external');
    const limitFlag = args.find(a => a.startsWith('--limit='));
    const limit = limitFlag ? parseInt(limitFlag.split('=')[1]) : null;

    console.log('PG-Git Tag Generator');
    console.log('====================');
    console.log(`Model: ${MODEL} @ ${OLLAMA_HOST}`);
    console.log(`Concurrency: ${CONCURRENCY}`);

    // Verify Ollama connectivity
    try {
        const resp = await fetch(`${OLLAMA_HOST}/api/tags`);
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        console.log('Ollama: connected ✓');
    } catch (e) {
        console.error(`Cannot reach Ollama at ${OLLAMA_HOST}: ${e.message}`);
        process.exit(1);
    }

    if (!projectFilter && !allExternal) {
        console.log('\nUsage: --project=NAME or --all-external');
        console.log('Available:', [...EXTERNAL_REPOS].join(', '));
        await pool.end();
        return;
    }

    // Query blobs that have content but no summary
    let queryText = `
        SELECT b.id, b.content, b.file_name, b.size, r.name as repo_name
        FROM blobs b
        JOIN repositories r ON b.repository_id = r.id
        WHERE b.summary IS NULL
          AND b.content IS NOT NULL
          AND b.size > 30
          AND b.size < 50000
    `;
    const params = [];

    if (projectFilter) {
        queryText += ` AND r.name = $1`;
        params.push(projectFilter);
        console.log(`Filter: project=${projectFilter}`);
    } else if (allExternal) {
        queryText += ` AND r.name = ANY($1)`;
        params.push([...EXTERNAL_REPOS]);
        console.log('Filter: all external repos');
    }

    // Prioritize embeddable source code files
    queryText += ` ORDER BY 
        CASE WHEN b.file_name ~ '\\.(ts|js|tsx|jsx|py|md)$' THEN 0 ELSE 1 END,
        b.size ASC`;

    if (limit) {
        queryText += ` LIMIT ${limit}`;
        console.log(`Limit: ${limit}`);
    }

    const result = await pool.query(queryText, params);
    console.log(`Found ${result.rows.length} blobs to tag.\n`);

    if (result.rows.length === 0) {
        console.log('Nothing to tag!');
        await pool.end();
        return;
    }

    await processBatch(result.rows);
    await pool.end();
}

main().catch(e => {
    console.error('Fatal:', e);
    process.exit(1);
});
