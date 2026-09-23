import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { query } from '../db/pool.js';
import { getEmbedding } from '../lib/embedding.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECTS_ROOT = path.resolve(__dirname, '..', '..');


export function hashContent(buffer) {
    // Basic SHA-1 similar to git blob hashing
    const header = `blob ${buffer.length}\0`;
    return crypto.createHash('sha1').update(header).update(buffer).digest('hex');
}

export async function createRepository(name, description = '') {
    const res = await query(
        `INSERT INTO repositories (name, description) VALUES ($1, $2) RETURNING *`,
        [name, description]
    );
    return res.rows[0];
}

export async function getRepositories() {
    const res = await query(`SELECT * FROM repositories ORDER BY created_at DESC`);
    return res.rows;
}

export async function getRepository(id) {
    const res = await query(`SELECT * FROM repositories WHERE id = $1`, [id]);
    return res.rows[0];
}

// Minimal placeholder for inserting a blob
export async function insertBlob(repoId, buffer) {
    const sha = hashContent(buffer);
    await query(
        `INSERT INTO blobs (id, repository_id, content, size) VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO NOTHING`,
        [sha, repoId, buffer, buffer.length]
    );
    return sha;
}

export async function getTreeEntries(treeId) {
    const res = await query(`SELECT * FROM tree_entries WHERE tree_id = $1`, [treeId]);
    return res.rows;
}

export async function getBlob(blobId) {
    const res = await query(`
        SELECT b.*, r.name AS project 
        FROM blobs b
        JOIN repositories r ON b.repository_id = r.id
        WHERE b.id = $1
    `, [blobId]);
    return res.rows[0];
}

export async function resolveBlobContent(blob) {
    if (!blob) return null;
    
    if (blob.storage_mode !== 'pointer') {
        return blob.content;
    }
    
    try {
        let projectName = blob.project;
        if (!projectName) {
            const repoRes = await query(`SELECT name FROM repositories WHERE id = $1`, [blob.repository_id]);
            if (repoRes.rows.length > 0) {
                projectName = repoRes.rows[0].name;
            }
        }
        
        if (!projectName || !blob.file_path) {
            return null;
        }
        
        const absolutePath = path.resolve(PROJECTS_ROOT, projectName, blob.file_path);
        // Verify path is safe and inside PROJECTS_ROOT to prevent path traversal
        if (!absolutePath.startsWith(PROJECTS_ROOT)) {
            throw new Error(`Path traversal detected: ${absolutePath}`);
        }
        
        return await fs.readFile(absolutePath);
    } catch (e) {
        console.error(`[resolveBlobContent] Failed to read pointer file for blob ${blob.id}: ${e.message}`);
        return null;
    }
}


export async function getRepoRootTree(repoId) {
    const res = await query(`
        SELECT c.tree_id 
        FROM branches b
        JOIN commits c ON b.commit_id = c.id
        WHERE b.repository_id = $1 AND b.name = 'main'
        LIMIT 1
    `, [repoId]);
    return res.rows[0]?.tree_id || null;
}

/**
 * Hybrid search (BM25 + Dense Semantic Vector via Reciprocal Rank Fusion / RRF)
 * with exponential temporal decay:
 * Final Score = RRF * exp(-0.01 * age_in_days)
 * 
 * Supports:
 * 1. queryOrVector: number[] (legacy vector) or string (text query).
 * 2. options: {
 *      search_type?: 'hybrid' | 'semantic' | 'keyword',
 *      query?: string,
 *      vector?: number[]
 *    }
 * 
 * Backward compatible with existing callers in krusch-context-mcp.
 */
export async function searchBlobs(queryOrVector, limit = 5, repositoryId, options = {}) {
    let vector = null;
    let textQuery = null;
    let searchType = options.search_type || 'hybrid';

    if (Array.isArray(queryOrVector)) {
        vector = queryOrVector;
        textQuery = options.query || null;
        if (!textQuery) {
            searchType = 'semantic';
        }
    } else if (typeof queryOrVector === 'string') {
        textQuery = queryOrVector;
        vector = options.vector || null;
    }

    // Attempt to obtain vector if doing hybrid or semantic search and vector is missing
    if (!vector && textQuery && searchType !== 'keyword') {
        try {
            vector = await getEmbedding(textQuery);
        } catch (e) {
            console.warn(`[searchBlobs] Embedding retrieval failed, falling back to keyword BM25: ${e.message}`);
        }
    }

    // Fallback: If vector could not be generated, fall back to keyword BM25 search
    if (!vector && searchType !== 'keyword') {
        searchType = 'keyword';
    }

    // 1. HYBRID SEARCH (RRF)
    if (searchType === 'hybrid' && vector && textQuery) {
        const vectorStr = `[${vector.join(',')}]`;
        const sql = `
            WITH dense_matches AS (
                SELECT 
                    b.id,
                    (1 - (b.embedding <=> $1::vector)) AS dense_sim,
                    ROW_NUMBER() OVER (ORDER BY (b.embedding <=> $1::vector) ASC) AS dense_rank
                FROM blobs b
                WHERE b.embedding IS NOT NULL
                  AND ($2::integer IS NULL OR b.repository_id = $2)
                LIMIT $3 * 4
            ),
            lexical_matches AS (
                SELECT 
                    b.id,
                    ts_rank_cd(b.tsv, plainto_tsquery('simple', $4)) AS bm25_score,
                    ROW_NUMBER() OVER (ORDER BY ts_rank_cd(b.tsv, plainto_tsquery('simple', $4)) DESC) AS bm25_rank
                FROM blobs b
                WHERE b.tsv @@ plainto_tsquery('simple', $4)
                  AND ($2::integer IS NULL OR b.repository_id = $2)
                LIMIT $3 * 4
            ),
            fused AS (
                SELECT 
                    COALESCE(d.id, l.id) AS id,
                    (
                        COALESCE(1.0 / (60.0 + d.dense_rank), 0.0) +
                        COALESCE(1.0 / (60.0 + l.bm25_rank), 0.0)
                    ) AS rrf_score,
                    COALESCE(d.dense_sim, 0.0) AS dense_sim,
                    COALESCE(l.bm25_score, 0.0) AS bm25_score
                FROM dense_matches d
                FULL OUTER JOIN lexical_matches l ON d.id = l.id
            )
            SELECT 
                b.id,
                b.repository_id,
                r.name AS project,
                COALESCE(b.summary, substring(encode(b.content, 'escape') from 1 for 500)) AS summary,
                b.storage_mode,
                b.last_seen_at,
                COALESCE(b.file_name, b.id) AS file_name,
                b.file_path,
                (f.rrf_score * exp(-0.01 * EXTRACT(EPOCH FROM (CURRENT_TIMESTAMP - COALESCE(b.last_seen_at, b.created_at))) / 86400.0)) AS similarity,
                f.dense_sim,
                f.bm25_score
            FROM fused f
            JOIN blobs b ON b.id = f.id
            JOIN repositories r ON r.id = b.repository_id
            ORDER BY similarity DESC
            LIMIT $3;
        `;
        const res = await query(sql, [vectorStr, repositoryId || null, limit, textQuery]);
        if (res.rows.length > 0) {
            return res.rows;
        }
        // If hybrid yielded 0 rows, fall through to dense search
    }

    // 2. DENSE SEMANTIC SEARCH (Pure vector)
    if (vector) {
        const vectorStr = `[${vector.join(',')}]`;
        let sql = `
            SELECT 
                b.id,
                b.repository_id,
                r.name AS project,
                COALESCE(b.summary, substring(encode(b.content, 'escape') from 1 for 500)) AS summary,
                b.storage_mode,
                b.last_seen_at,
                COALESCE(b.file_name, b.id) AS file_name,
                b.file_path,
                (1 - (b.embedding <=> $1::vector)) 
                    * exp(-0.01 * EXTRACT(EPOCH FROM (CURRENT_TIMESTAMP - COALESCE(b.last_seen_at, b.created_at))) / 86400.0)
                AS similarity
            FROM blobs b
            JOIN repositories r ON r.id = b.repository_id
            WHERE b.embedding IS NOT NULL
        `;
        const params = [vectorStr];
        if (repositoryId !== undefined && repositoryId !== null) {
            params.push(repositoryId);
            sql += ` AND b.repository_id = $${params.length}`;
        }
        params.push(limit);
        sql += ` ORDER BY similarity DESC LIMIT $${params.length}`;

        const res = await query(sql, params);
        if (res.rows.length > 0 || !textQuery) {
            return res.rows;
        }
    }

    // 3. LEXICAL BM25 SEARCH (Fallback or pure keyword)
    if (textQuery) {
        let sql = `
            SELECT 
                b.id,
                b.repository_id,
                r.name AS project,
                COALESCE(b.summary, substring(encode(b.content, 'escape') from 1 for 500)) AS summary,
                b.storage_mode,
                b.last_seen_at,
                COALESCE(b.file_name, b.id) AS file_name,
                b.file_path,
                (COALESCE(ts_rank_cd(b.tsv, plainto_tsquery('simple', $1)), 0.1)
                    * exp(-0.01 * EXTRACT(EPOCH FROM (CURRENT_TIMESTAMP - COALESCE(b.last_seen_at, b.created_at))) / 86400.0))
                AS similarity
            FROM blobs b
            JOIN repositories r ON r.id = b.repository_id
            WHERE (b.tsv @@ plainto_tsquery('simple', $1) 
                   OR b.file_name ILIKE '%' || $1 || '%' 
                   OR b.file_path ILIKE '%' || $1 || '%')
        `;
        const params = [textQuery];
        if (repositoryId !== undefined && repositoryId !== null) {
            params.push(repositoryId);
            sql += ` AND b.repository_id = $${params.length}`;
        }
        params.push(limit);
        sql += ` ORDER BY similarity DESC LIMIT $${params.length}`;

        const res = await query(sql, params);
        return res.rows;
    }

    return [];
}

/**
 * Search code symbols (functions, classes, methods, routes) across repositories.
 * Matches exact symbol names first, then prefix/substring, then full-text simple tsv.
 * 
 * @param {string} queryText - The symbol name or query.
 * @param {number} limit - Maximum symbols to return.
 * @param {number|null} repositoryId - Optional repository filter.
 * @param {object} options - Optional filters { symbol_type: 'function'|'class'|'method'|'route' }.
 * @returns {Promise<Array>}
 */
export async function searchSymbols(queryText, limit = 10, repositoryId = null, options = {}) {
    const symbolType = options.symbol_type || null;
    
    let sql = `
        SELECT 
            s.id,
            s.blob_id,
            s.repository_id,
            r.name AS project,
            s.file_path,
            s.symbol_name,
            s.symbol_type,
            s.start_line,
            s.end_line,
            s.signature,
            s.content,
            (
                CASE 
                    WHEN LOWER(s.symbol_name) = LOWER($1) THEN 1.0
                    WHEN s.symbol_name ILIKE '%' || $1 || '%' THEN 0.85
                    ELSE COALESCE(ts_rank_cd(s.tsv, plainto_tsquery('simple', $1)), 0.1)
                END
            ) AS similarity
        FROM code_symbols s
        JOIN repositories r ON r.id = s.repository_id
        WHERE (
            LOWER(s.symbol_name) = LOWER($1)
            OR s.symbol_name ILIKE '%' || $1 || '%'
            OR s.tsv @@ plainto_tsquery('simple', $1)
        )
    `;
    const params = [queryText];
    if (repositoryId) {
        params.push(repositoryId);
        sql += ` AND s.repository_id = $${params.length}`;
    }
    if (symbolType) {
        params.push(symbolType);
        sql += ` AND s.symbol_type = $${params.length}`;
    }
    params.push(limit);
    sql += ` ORDER BY similarity DESC, s.start_line ASC LIMIT $${params.length}`;

    const res = await query(sql, params);
    return res.rows;
}

/**
 * Get all symbols defined in a given blob/file.
 * 
 * @param {string} blobId - The SHA-1 hash of the blob.
 * @returns {Promise<Array>}
 */
export async function getSymbolsForBlob(blobId) {
    const res = await query(`
        SELECT s.*, r.name AS project
        FROM code_symbols s
        JOIN repositories r ON r.id = s.repository_id
        WHERE s.blob_id = $1
        ORDER BY s.start_line ASC
    `, [blobId]);
    return res.rows;
}

/**
 * Get symbol and import dependency graph for a file.
 * Returns outbound imports, inbound dependents, and internal symbol declarations.
 * 
 * @param {string} filePath - Target file path.
 * @param {number} repositoryId - The repository ID.
 * @returns {Promise<{ filePath: string, repositoryId: number, symbols: Array, imports: Array, dependents: Array }>}
 */
export async function getSymbolGraph(filePath, repositoryId) {
    // Outbound imports
    const importsRes = await query(`
        SELECT target_path, relation, symbols
        FROM code_symbol_edges
        WHERE repository_id = $1 AND source_path = $2
        ORDER BY target_path ASC
    `, [repositoryId, filePath]);

    // Inbound dependents (files that import this file)
    const baseName = path.basename(filePath, path.extname(filePath));
    const dependentsRes = await query(`
        SELECT source_path, relation, symbols
        FROM code_symbol_edges
        WHERE repository_id = $1 
          AND (target_path = $2 OR target_path ILIKE '%' || $3 || '%')
        ORDER BY source_path ASC
    `, [repositoryId, filePath, baseName]);

    // File's own symbols
    const symbolsRes = await query(`
        SELECT symbol_name, symbol_type, start_line, end_line, signature
        FROM code_symbols
        WHERE repository_id = $1 AND file_path = $2
        ORDER BY start_line ASC
    `, [repositoryId, filePath]);

    return {
        filePath,
        repositoryId,
        symbols: symbolsRes.rows,
        imports: importsRes.rows,
        dependents: dependentsRes.rows
    };
}


