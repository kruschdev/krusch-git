#!/usr/bin/env node
/**
 * Advanced Homelab Tag & Summary Optimizer.
 * Reads pointer-based local monorepo files on the fly and generates rich semantic summaries 
 * and developer tags using local qwen2.5-coder:7b.
 * 
 * Usage:
 *   node scripts/generate_homelab_tags.js --repo=berean
 *   node scripts/generate_homelab_tags.js --all
 */

import pg from 'pg';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import 'dotenv/config';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OLLAMA_HOST = process.env.TAG_OLLAMA_HOST || 'http://localhost:11434';
const MODEL = process.env.TAG_MODEL || 'qwen2.5-coder:7b';
const CONCURRENCY = parseInt(process.env.TAG_CONCURRENCY || '3', 10);
const MONOREPO_ROOT = process.env.MONOREPO_ROOT || path.resolve(__dirname, '../../..');

const pool = new pg.Pool({
    host: process.env.DB_HOST || '10.0.0.144',
    port: parseInt(process.env.DB_PORT || '5435', 10),
    user: process.env.DB_USER || 'kruschdb',
    password: process.env.DB_PASSWORD || 'password',
    database: process.env.DB_NAME || 'kruschdb'
});

const SYSTEM_PROMPT = `You are an elite code architect and librarian. Given a source code file, output a JSON object with:
- "summary": A highly precise 1-sentence description (max 140 chars) of what this file implements/does. Be specific about the domain, design pattern, or technologies used.
- "tags": An array of exactly 4-5 lowercase tags categorizing the file (e.g. "auth", "db-pool", "vector-search", "workflow", "mcp-server", "state-machine", "middleware").

Rules:
- Never use generic placeholder phrases like "This file contains..." or "Code to implement..."
- Output ONLY valid raw JSON. No markdown backticks, no markdown fence block, no conversational text.

Example output:
{"summary":"Connection pool initialization and transaction helper wrapper for PostgreSQL database","tags":["database","postgres","pool","transactions","sql"]}`;

/**
 * Request structured tags and summary from Ollama
 */
async function generateTags(content, fileName) {
    const truncated = content.substring(0, 5000); // 5k chars provides ample context
    const prompt = `File: ${fileName}\n\n\`\`\`\n${truncated}\n\`\`\``;

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
                    num_predict: 250,
                    top_p: 0.9
                }
            })
        });

        if (!resp.ok) {
            const err = await resp.text();
            throw new Error(`Ollama status ${resp.status}: ${err}`);
        }

        const data = await resp.json();
        const raw = data.response?.trim();
        if (!raw) return null;

        // Parse JSON — handle common LLM quirks
        let cleaned = raw;
        cleaned = cleaned.replace(/^```json?\s*/i, '').replace(/\s*```$/i, '');
        const lastBrace = cleaned.lastIndexOf('}');
        if (lastBrace > 0) cleaned = cleaned.substring(0, lastBrace + 1);

        const parsed = JSON.parse(cleaned);
        if (!parsed.summary || !Array.isArray(parsed.tags)) return null;

        return {
            summary: String(parsed.summary).substring(0, 200),
            tags: parsed.tags.slice(0, 6).map(t => String(t).toLowerCase().trim().substring(0, 30))
        };
    } catch (e) {
        return null;
    }
}

async function processBlobs(blobs) {
    let processed = 0;
    let skipped = 0;
    let failed = 0;
    const startTime = Date.now();

    console.log(`[Tagger] Spawning ${CONCURRENCY} parallel workers to optimize ${blobs.length} blobs...\n`);

    const logInterval = setInterval(() => {
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        const rate = processed > 0 ? (processed / (Date.now() - startTime) * 1000).toFixed(2) : '0';
        const pct = ((processed + skipped + failed) / blobs.length * 100).toFixed(1);
        console.log(`[${elapsed}s] Optimized: ${processed} | Skipped: ${skipped} | Failed: ${failed} | Progress: ${pct}% | Rate: ${rate}/s`);
    }, 15_000);

    const queue = [...blobs];
    const workers = Array.from({ length: CONCURRENCY }, async () => {
        while (queue.length > 0) {
            const blob = queue.shift();
            if (!blob) break;

            // Resolve local path
            const rootDirs = ['scripts', 'lib', 'lib-py', '.agent'];
            let fullPath;
            if (rootDirs.includes(blob.repo_name)) {
                fullPath = path.join(MONOREPO_ROOT, blob.repo_name, blob.file_path);
            } else {
                fullPath = path.join(MONOREPO_ROOT, 'projects', blob.repo_name, blob.file_path);
            }

            let content = '';
            try {
                content = await fs.readFile(fullPath, 'utf-8');
            } catch (err) {
                skipped++;
                continue;
            }

            if (!content || content.length < 40) {
                skipped++;
                continue;
            }

            // Skip binary lookalikes
            if (/[\x00-\x08\x0e-\x1f]/.test(content.substring(0, 200))) {
                skipped++;
                continue;
            }

            try {
                const result = await generateTags(content, blob.file_name || 'unknown');
                if (result) {
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
            }
        }
    });

    await Promise.all(workers);
    clearInterval(logInterval);

    const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`\n🎉 Tag & Summary Optimization Complete!`);
    console.log(`   - Optimized: ${processed}`);
    console.log(`   - Skipped:   ${skipped}`);
    console.log(`   - Failed:    ${failed}`);
    console.log(`   - Total Time: ${totalTime}s`);
}

async function main() {
    const args = process.argv.slice(2);
    const repoFlag = args.find(a => a.startsWith('--repo='));
    const repoFilter = repoFlag ? repoFlag.split('=')[1] : null;
    const allFlag = args.includes('--all');

    if (!repoFilter && !allFlag) {
        console.log('Usage: node scripts/generate_homelab_tags.js --repo=NAME or --all');
        await pool.end();
        return;
    }

    // Verify Ollama connection
    try {
        const resp = await fetch(`${OLLAMA_HOST}/api/tags`);
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        console.log(`Connected to Ollama at ${OLLAMA_HOST} ✓`);
    } catch (e) {
        console.error(`Cannot connect to Ollama at ${OLLAMA_HOST}: ${e.message}`);
        process.exit(1);
    }

    // Query for local files that need optimized tags
    let queryText = `
        SELECT b.id, b.file_name, b.file_path, b.size, r.name as repo_name
        FROM blobs b
        JOIN repositories r ON b.repository_id = r.id
        WHERE (b.summary IS NULL OR length(b.summary) >= 450 OR b.summary NOT LIKE '%[%]%')
          AND b.file_name ~ '\\.(js|ts|jsx|tsx|py|sql|sh)$'
          AND b.size > 30
          AND b.size < 50000
    `;
    const params = [];

    if (repoFilter) {
        queryText += ` AND r.name = $1`;
        params.push(repoFilter);
        console.log(`Target Repository: ${repoFilter}`);
    } else {
        // Exclude large external repos to focus purely on custom homelab code
        const externalRepos = ['langchainjs', 'ai', 'typescript-sdk', 'mcp-servers', 'mastra', 'langgraphjs', 'openai-node', 'generative-ai-js', 'LlamaIndexTS', 'voltagent', 'langchain', 'agent-framework', 'ai-agents-for-beginners', 'goose-repo', 'generative-ai', 'openai-cookbook', 'beeai-framework', 'GenAI_Agents'];
        queryText += ` AND r.name != ALL($1)`;
        params.push(externalRepos);
        console.log('Target: All Custom Homelab Repositories (excluding external dependencies)');
    }

    queryText += ` ORDER BY b.size ASC`;

    const result = await pool.query(queryText, params);
    console.log(`Found ${result.rows.length} files requiring semantic tagging.\n`);

    if (result.rows.length === 0) {
        console.log('No files require tagging!');
        await pool.end();
        return;
    }

    await processBlobs(result.rows);
    await pool.end();
}

main().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
});
