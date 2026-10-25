#!/usr/bin/env node

import { execFile } from 'child_process';
import util from 'util';
import path from 'path';
import crypto from 'crypto';
import { query, pool } from '../db/pool.js';
import { getEmbedding, isEmbeddable, MAX_EMBED_CHARS } from '../lib/embedding.js';
import { extractSymbolsAndImports, computeSymbolHash } from '../lib/ast-chunker.js';

const execFilePromise = util.promisify(execFile);
const HEX_SHA_RE = /^[0-9a-f]{40}$/i;

function assertValidSha(sha, label = 'Git object SHA') {
    if (typeof sha !== 'string' || !HEX_SHA_RE.test(sha)) {
        throw new Error(`Invalid ${label}: ${sha}`);
    }
}

async function isGitRepo(targetDir) {
    try {
        await execFilePromise('git', ['rev-parse', '--is-inside-work-tree'], { cwd: targetDir });
        return true;
    } catch {
        return false;
    }
}

export async function populateSymbolsAndEdges(blobHash, repoId, name, parsedSymbols, parsedImports) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await client.query(`DELETE FROM code_symbols WHERE repository_id = $2 AND (blob_id = $1 OR file_path = $3)`, [blobHash, repoId, name]);
        await client.query(`DELETE FROM code_symbol_edges WHERE repository_id = $2 AND (source_blob_id = $1 OR source_path = $3)`, [blobHash, repoId, name]);

        if (parsedSymbols && parsedSymbols.length > 0) {
            const BATCH_SIZE = 50;
            for (let i = 0; i < parsedSymbols.length; i += BATCH_SIZE) {
                const batch = parsedSymbols.slice(i, i + BATCH_SIZE);
                const values = [];
                const params = [];
                let pIdx = 1;
                for (const sym of batch) {
                    const symHash = sym.symbol_hash || sym.symbolHash || computeSymbolHash(sym.content || sym.signature || sym.name);
                    values.push(`($${pIdx}, $${pIdx+1}, $${pIdx+2}, $${pIdx+3}, $${pIdx+4}, $${pIdx+5}, $${pIdx+6}, $${pIdx+7}, $${pIdx+8}, $${pIdx+9})`);
                    params.push(blobHash, repoId, name, sym.name, sym.type, sym.startLine, sym.endLine, sym.signature, sym.content, symHash);
                    pIdx += 10;
                }
                await client.query(`
                    INSERT INTO code_symbols (blob_id, repository_id, file_path, symbol_name, symbol_type, start_line, end_line, signature, content, symbol_hash)
                    VALUES ${values.join(', ')}
                `, params);
            }
        }

        if (parsedImports && parsedImports.length > 0) {
            const BATCH_SIZE = 50;
            for (let i = 0; i < parsedImports.length; i += BATCH_SIZE) {
                const batch = parsedImports.slice(i, i + BATCH_SIZE);
                const values = [];
                const params = [];
                let pIdx = 1;
                for (const imp of batch) {
                    values.push(`($${pIdx}, $${pIdx+1}, $${pIdx+2}, $${pIdx+3}, $${pIdx+4}, $${pIdx+5})`);
                    params.push(repoId, blobHash, name, imp.targetPath, imp.relation, imp.symbols);
                    pIdx += 6;
                }
                await client.query(`
                    INSERT INTO code_symbol_edges (repository_id, source_blob_id, source_path, target_path, relation, symbols)
                    VALUES ${values.join(', ')}
                `, params);
            }
        }

        await client.query('COMMIT');
    } catch (err) {
        try {
            await client.query('ROLLBACK');
        } catch (rollbackErr) {
            console.error(`[Import] Rollback failed for ${name}: ${rollbackErr.message}`);
        }
        throw err;
    } finally {
        client.release();
    }
}

async function processBlob(blobHash, name, repoId, targetDir) {
    assertValidSha(blobHash, 'blob SHA');
    const existing = await query(`SELECT id FROM blobs WHERE id = $1`, [blobHash]);
    if (existing.rows.length > 0) {
        await query(`UPDATE blobs SET last_seen_at = CURRENT_TIMESTAMP WHERE id = $1`, [blobHash]);
        return;
    }

    try {
        const { stdout } = await execFilePromise('git', ['cat-file', '-p', blobHash], {
            cwd: targetDir,
            encoding: 'buffer',
            maxBuffer: 1024 * 1024 * 50
        }); // 50MB max
        const ext = path.extname(name).toLowerCase();
        let embeddingStr = null;
        let parsedSymbols = [];
        let parsedImports = [];

        if (isEmbeddable(ext)) {
            const text = stdout.toString('utf-8');
            if (text.length < MAX_EMBED_CHARS) {
                console.log(`[Embed] Generating vector for blob: ${blobHash.substring(0, 7)} (${name})`);
                const vector = await getEmbedding(text);
                if (vector) {
                    embeddingStr = `[${vector.join(',')}]`;
                }
            }

            try {
                const extracted = extractSymbolsAndImports(text, name);
                parsedSymbols = extracted.symbols || [];
                parsedImports = extracted.imports || [];
            } catch (err) {
                console.warn(`[AST] Symbol extraction skipped for ${name} (${blobHash.substring(0, 7)}): ${err.message}`);
            }
        }

        const fileName = path.basename(name);
        if (embeddingStr) {
            await query(
                `INSERT INTO blobs (id, repository_id, content, size, embedding, file_name, file_path, storage_mode) VALUES ($1, $2, $3, $4, $5::vector, $6, $7, 'direct') ON CONFLICT (id) DO UPDATE SET file_name = EXCLUDED.file_name, file_path = EXCLUDED.file_path`,
                [blobHash, repoId, stdout, stdout.length, embeddingStr, fileName, name]
            );
        } else {
            await query(
                `INSERT INTO blobs (id, repository_id, content, size, file_name, file_path, storage_mode) VALUES ($1, $2, $3, $4, $5, $6, 'direct') ON CONFLICT (id) DO UPDATE SET file_name = EXCLUDED.file_name, file_path = EXCLUDED.file_path`,
                [blobHash, repoId, stdout, stdout.length, fileName, name]
            );
        }

        if (isEmbeddable(ext)) {
            await populateSymbolsAndEdges(blobHash, repoId, name, parsedSymbols, parsedImports);
        }
    } catch (e) {
        console.error(`Failed to process blob ${blobHash}:`, e.message);
    }
}

async function processTree(treeHash, repoId, targetDir) {
    assertValidSha(treeHash, 'tree SHA');
    const existing = await query(`SELECT id FROM trees WHERE id = $1`, [treeHash]);
    if (existing.rows.length > 0) return;

    try {
        const { stdout } = await execFilePromise('git', ['ls-tree', treeHash], { cwd: targetDir });
        const lines = stdout.trim().split('\n').filter(l => l.length > 0);

        // Insert tree first
        await query(`INSERT INTO trees (id, repository_id) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING`, [treeHash, repoId]);

        const entries = [];
        for (const line of lines) {
            // Format: 100644 blob hash    filename
            const match = line.match(/^\d+ (\w+) ([a-f0-9]{40})\t(.*)$/i);
            if (!match) continue;
            
            const [_, type, objectId, name] = match;

            if (type === 'tree') {
                await processTree(objectId, repoId, targetDir);
            } else if (type === 'blob') {
                await processBlob(objectId, name, repoId, targetDir);
            }
            entries.push({ type, name, objectId });
        }

        const BATCH_SIZE = 100;
        for (let i = 0; i < entries.length; i += BATCH_SIZE) {
            const batch = entries.slice(i, i + BATCH_SIZE);
            const values = [];
            const params = [];
            let pIdx = 1;
            for (const entry of batch) {
                values.push(`($${pIdx}, $${pIdx+1}, $${pIdx+2}, $${pIdx+3})`);
                params.push(treeHash, entry.type, entry.name, entry.objectId);
                pIdx += 4;
            }
            await query(
                `INSERT INTO tree_entries (tree_id, type, name, object_id) VALUES ${values.join(', ')} ON CONFLICT (tree_id, name) DO NOTHING`,
                params
            );
        }
    } catch (e) {
        console.error(`Failed to process tree ${treeHash}:`, e.message);
    }
}

async function main() {
    const targetDir = process.argv[2] ? path.resolve(process.argv[2]) : process.cwd();
    
    if (!(await isGitRepo(targetDir))) {
        console.error(`Error: Directory is not a valid git repository: ${targetDir}`);
        process.exit(1);
    }

    const repoName = path.basename(targetDir);
    console.log(`Starting GitHub Import for: ${repoName}`);

    // Get or Create Repo
    let repoId;
    const res = await query(`SELECT id FROM repositories WHERE name = $1`, [repoName]);
    if (res.rows.length > 0) {
        repoId = res.rows[0].id;
    } else {
        const inserted = await query(`INSERT INTO repositories (name, description) VALUES ($1, $2) RETURNING id`, [repoName, `Imported from git repository`]);
        repoId = inserted.rows[0].id;
    }

    // Fetch Commits
    // Format: Hash|ParentHash|AuthorName|CommitMessage
    const { stdout: logOut } = await execFilePromise('git', ['log', '--reverse', '--format=%H|%P|%an|%s'], { cwd: targetDir });
    const commits = logOut.trim().split('\n').filter(l => l.length > 0);

    console.log(`Found ${commits.length} commits to process...`);

    let latestCommitSha = null;

    for (let i = 0; i < commits.length; i++) {
        const line = commits[i];
        const parts = line.split('|');
        const hash = parts[0];
        assertValidSha(hash, 'commit SHA');
        // Git log parent hashes are space separated. Take the first one for simplicity.
        const parentHash = parts[1] ? parts[1].split(' ')[0] : null;
        if (parentHash) assertValidSha(parentHash, 'parent commit SHA');
        const author = parts[2] || 'Unknown';
        const message = parts.slice(3).join('|') || 'No message';

        const existingCommit = await query(`SELECT id FROM commits WHERE id = $1`, [hash]);
        if (existingCommit.rows.length > 0) {
            latestCommitSha = hash;
            continue;
        }

        console.log(`[${i + 1}/${commits.length}] Importing commit: ${hash.substring(0, 7)} - ${message}`);

        // Get Tree Hash
        const { stdout: treeOut } = await execFilePromise('git', ['show', '-s', '--format=%T', hash], { cwd: targetDir });
        const treeHash = treeOut.trim();
        assertValidSha(treeHash, 'commit tree SHA');

        // Process the entire tree recursively
        await processTree(treeHash, repoId, targetDir);

        // Insert Commit
        await query(
            `INSERT INTO commits (id, repository_id, tree_id, parent_id, message, author) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (id) DO NOTHING`,
            [hash, repoId, treeHash, parentHash, message, author]
        );

        latestCommitSha = hash;
    }

    // Update main branch
    if (latestCommitSha) {
        // Find current branch name
        const { stdout: branchOut } = await execFilePromise('git', ['branch', '--show-current'], { cwd: targetDir });
        const branchName = branchOut.trim() || 'main';

        const branchRes = await query(`SELECT id FROM branches WHERE repository_id = $1 AND name = $2`, [repoId, branchName]);
        if (branchRes.rows.length > 0) {
            await query(`UPDATE branches SET commit_id = $1 WHERE repository_id = $2 AND name = $3`, [latestCommitSha, repoId, branchName]);
        } else {
            await query(`INSERT INTO branches (repository_id, name, commit_id) VALUES ($1, $2, $3)`, [repoId, branchName, latestCommitSha]);
        }
        console.log(`✅ Import complete! Branch '${branchName}' updated to point to ${latestCommitSha.substring(0, 7)}`);
    }

    await pool.end();
}

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);
if (isDirectRun) {
    main().catch(err => {
        console.error('Fatal Error:', err);
        process.exit(1);
    });
}
