import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { query } from '../db/pool.js';
import { getEmbedding, getActiveEmbedModel, calibrateQuerySimilarity, PRIORITY } from '../lib/embedding.js';
import { computeSymbolHash } from '../lib/ast-chunker.js';
import { hashContent as _hashContent } from '../lib/hash.js';
import { createRepository as _createRepository, getRepositories, getRepository } from '../db/repository-service.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECTS_ROOT = path.resolve(__dirname, '..', '..');
export function hashContent(buffer) {
    // Delegates crypto.createHash('sha1') to ../lib/hash.js
    return _hashContent(buffer);
}

export async function createRepository(name, description) {
    return _createRepository(name, description);
}
export { getRepositories, getRepository };
import { buildExpandedEnglishQuery, expandCodeGraphBridges } from '../lib/graph-bridge.js';
// Minimal placeholder for inserting a blob
export async function insertBlob(repoId, buffer) {
    const sha = hashContent(buffer);
    await query(
        `INSERT INTO blobs (id, repository_id, content, size) VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO NOTHING`,
        [sha, repoId, buffer, buffer.length]
    );
    return sha;
}

export async function getTreeEntries(treeId, repositoryId = null) {
    if (repositoryId !== undefined && repositoryId !== null) {
        const res = await query(`
            SELECT te.*
            FROM tree_entries te
            JOIN trees t ON te.tree_id = t.id
            WHERE te.tree_id = $1 AND t.repository_id = $2
        `, [treeId, repositoryId]);
        return res.rows;
    }
    const res = await query(`SELECT * FROM tree_entries WHERE tree_id = $1`, [treeId]);
    return res.rows;
}

export async function getBlob(blobId, queryFn = query) {
    try {
        const res = await queryFn(`
            SELECT b.*, r.name AS project 
            FROM blobs b
            JOIN repositories r ON b.repository_id = r.id
            WHERE b.id = $1
        `, [blobId]);
        if (!res || !Array.isArray(res.rows) || !res.rows.length) {
            return null;
        }
        return res.rows[0];
    } catch (err) {
        console.error('[krusch-git] getBlob query failed:', err?.message || 'unknown error');
        throw new Error('Database query failed');
    }
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
        
        const safeProject = path.basename(String(projectName || '').trim());
        const cleanFilePath = String(blob.file_path || '').trim().replace(/^[/\\]+/, '');
        if (!safeProject || safeProject === '.' || safeProject === '..' || !cleanFilePath) {
            return null;
        }

        if (cleanFilePath.includes('\0') || safeProject.includes('\0')) {
            throw new Error(`Path traversal / invalid characters detected in ${cleanFilePath}`);
        }

        // Primary: look inside PROJECTS_ROOT/<project>/<file_path>
        const projectDir = path.resolve(PROJECTS_ROOT, safeProject);
        const absolutePath = path.resolve(projectDir, cleanFilePath);
        const relToProject = path.relative(projectDir, absolutePath);

        // Strict containment: must remain strictly inside this specific project directory
        if (relToProject.startsWith('..') || path.isAbsolute(relToProject) || relToProject === '') {
            throw new Error(`Path traversal detected: ${absolutePath} is outside repository root ${projectDir}`);
        }

        // Secondary fallback: check root-level homelab directories (e.g. scripts, lib, .agent)
        const MONOREPO_ROOT = path.resolve(PROJECTS_ROOT, '..');
        const altProjectDir = path.resolve(MONOREPO_ROOT, safeProject);
        const altPath = path.resolve(altProjectDir, cleanFilePath);
        const relToAlt = path.relative(altProjectDir, altPath);

        let targetPath = absolutePath;
        let baseDir = projectDir;

        // Check if primary path exists; if not, check secondary altPath if valid
        let stat = null;
        try {
            stat = await fs.stat(absolutePath);
        } catch (e) {
            if (e.code === 'ENOENT' && !relToAlt.startsWith('..') && !path.isAbsolute(relToAlt) && relToAlt !== '') {
                try {
                    stat = await fs.stat(altPath);
                    targetPath = altPath;
                    baseDir = altProjectDir;
                } catch (altErr) {
                    // Neither exists
                }
            }
        }

        if (!stat) {
            return null;
        }

        // Symlink dereference verification: realpath must also remain inside realBaseDir
        const realBaseDir = await fs.realpath(baseDir);
        const realTarget = await fs.realpath(targetPath);
        const relReal = path.relative(realBaseDir, realTarget);
        if (relReal.startsWith('..') || path.isAbsolute(relReal)) {
            throw new Error(`Symlink traversal detected: ${realTarget} points outside ${realBaseDir}`);
        }
        
        return await fs.readFile(realTarget);
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

async function queryWithLegacySchemaFallback(modernSql, modernParams, buildLegacy) {
    try {
        return await query(modernSql, modernParams);
    } catch (err) {
        if (err && err.code === '42703' && typeof buildLegacy === 'function') {
            const { sql: legacySql, params: legacyParams } = buildLegacy();
            return await query(legacySql, legacyParams);
        }
        throw err;
    }
}

/**
 * Hybrid search (BM25 + Dense Semantic Vector via Reciprocal Rank Fusion / RRF)
 * with exponential temporal decay, latest-blob deduplication per (repository_id, file_path),
 * embed_model space isolation, isotropic cosine calibration, and gated 2-hop graph bridging.
 * 
 * Supports:
 * 1. queryOrVector: number[] (legacy vector) or string (text query).
 * 2. options: string ('hybrid' | 'semantic' | 'keyword') OR {
 *      search_type?: 'hybrid' | 'semantic' | 'keyword',
 *      query?: string,
 *      vector?: number[],
 *      embeddingAttempted?: boolean,
 *      include_bridges?: boolean
 *    }
 * 
 * Backward compatible with existing callers in krusch-context-mcp and REST API.
 */
export async function searchBlobs(queryOrVector, limit = 5, repositoryId = null, options = {}) {
    if (typeof queryOrVector !== 'string' && !Array.isArray(queryOrVector)) {
        throw new TypeError('queryOrVector must be a string or number[]');
    }
    if (!Number.isInteger(limit) || limit <= 0) {
        throw new TypeError('limit must be a positive integer');
    }
    if (
        repositoryId !== undefined &&
        repositoryId !== null &&
        typeof repositoryId !== 'string' &&
        typeof repositoryId !== 'number'
    ) {
        throw new TypeError('repositoryId must be a string or number');
    }
    if (options !== undefined && options !== null && typeof options !== 'string' && (typeof options !== 'object' || Array.isArray(options))) {
        throw new TypeError('options must be an object or a recognized string');
    }
    const normalizedOptions = typeof options === 'string'
        ? { search_type: options }
        : (options || {});
    const allowedOptionKeys = ['search_type', 'query', 'vector', 'embeddingAttempted', 'include_bridges'];
    const invalidKeys = Object.keys(normalizedOptions).filter(k => !allowedOptionKeys.includes(k));
    if (invalidKeys.length) {
        throw new TypeError(`Invalid option keys: ${invalidKeys.join(', ')}`);
    }

    let vector = null;
    let textQuery = null;
    const requestedSearchType = normalizedOptions.search_type || 'hybrid';
    let searchType = requestedSearchType;
    const hasExplicitVectorOption = Object.prototype.hasOwnProperty.call(normalizedOptions, 'vector') || normalizedOptions.embeddingAttempted === true;

    if (Array.isArray(queryOrVector)) {
        vector = queryOrVector;
        textQuery = normalizedOptions.query || null;
        if (!textQuery) {
            searchType = 'semantic';
        }
    } else if (typeof queryOrVector === 'string') {
        textQuery = queryOrVector;
        vector = normalizedOptions.vector || null;
    }

    // Attempt to obtain vector at HIGH priority if doing hybrid or semantic search and vector was not already attempted
    if (!vector && !hasExplicitVectorOption && textQuery && searchType !== 'keyword') {
        try {
            vector = await getEmbedding(textQuery, PRIORITY.HIGH, { mode: 'query' });
        } catch (e) {
            console.warn(`[searchBlobs] Embedding retrieval failed, falling back to keyword BM25: ${e.message}`);
        }
    }

    // Fallback: If vector could not be generated, fall back to keyword BM25 search
    if (!vector && searchType !== 'keyword') {
        searchType = 'keyword';
    }

    const safeLimit = Math.max(1, Math.min(Number(limit) || 5, 100));
    const scopedRepoId = (repositoryId !== undefined && repositoryId !== null && String(repositoryId).trim() !== '')
        ? (Number.isNaN(Number(repositoryId)) ? repositoryId : Number(repositoryId))
        : null;
    const activeModel = getActiveEmbedModel();
    const expandedQuery = textQuery ? buildExpandedEnglishQuery(textQuery) : '';
    const shouldBridge = (
        (requestedSearchType === 'hybrid' || normalizedOptions.include_bridges === true) &&
        normalizedOptions.include_bridges !== false &&
        Boolean(textQuery)
    );

    const repoFilterParam2 = scopedRepoId !== null ? 'AND b.repository_id = $2' : 'AND ($2::integer IS NULL)';
    const repoFilterParam4 = scopedRepoId !== null ? 'AND b.repository_id = $4' : 'AND ($4::integer IS NULL)';

    // 1. HYBRID SEARCH (RRF — HNSW + single-tsquery GIN + B-Tree NOT EXISTS latest-blob deduplication)
    if (searchType === 'hybrid' && vector && textQuery) {
        const vectorStr = `[${vector.join(',')}]`;
        const sql = `
            WITH tsq AS MATERIALIZED (
                SELECT (
                    plainto_tsquery('simple', $4)
                    || plainto_tsquery('english', $4)
                    || CASE WHEN $5 <> '' THEN websearch_to_tsquery('english', $5) ELSE ''::tsquery END
                ) AS q
            ),
            dense_raw AS MATERIALIZED (
                SELECT
                    b.id,
                    b.repository_id,
                    b.file_path,
                    b.last_seen_at,
                    b.created_at,
                    (1 - (b.embedding <=> $1::vector)) AS dense_sim
                FROM blobs b
                WHERE b.embedding IS NOT NULL
                  AND (b.embed_model IS NULL OR b.embed_model = $6)
                  ${repoFilterParam2}
                ORDER BY b.embedding <=> $1::vector ASC
                LIMIT GREATEST(150, $3 * 20)
            ),
            dense_matches AS (
                SELECT
                    d.id,
                    d.dense_sim,
                    ROW_NUMBER() OVER (ORDER BY d.dense_sim DESC) AS dense_rank
                FROM dense_raw d
                WHERE d.file_path IS NULL OR NOT EXISTS (
                    SELECT 1 FROM blobs b2
                    WHERE b2.repository_id = d.repository_id
                      AND b2.file_path = d.file_path
                      AND (
                          COALESCE(b2.last_seen_at, b2.created_at, '-infinity'::timestamptz) > COALESCE(d.last_seen_at, d.created_at, '-infinity'::timestamptz)
                          OR (
                              COALESCE(b2.last_seen_at, b2.created_at, '-infinity'::timestamptz) = COALESCE(d.last_seen_at, d.created_at, '-infinity'::timestamptz)
                              AND b2.id > d.id
                          )
                      )
                )
                ORDER BY d.dense_sim DESC
                LIMIT GREATEST(60, $3 * 10)
            ),
            lexical_raw AS MATERIALIZED (
                SELECT
                    b.id,
                    b.repository_id,
                    b.file_path,
                    b.last_seen_at,
                    b.created_at,
                    (
                        COALESCE(ts_rank_cd(b.tsv, plainto_tsquery('simple', $4)), 0.0) * 1.5 +
                        COALESCE(ts_rank_cd(b.tsv, plainto_tsquery('english', $4)), 0.0) * 1.25 +
                        CASE
                            WHEN $5 <> '' THEN COALESCE(ts_rank_cd(b.tsv, websearch_to_tsquery('english', $5)), 0.0)
                            ELSE 0.0
                        END
                    ) AS bm25_score
                FROM blobs b, tsq
                WHERE tsq.q <> ''::tsquery
                  AND b.tsv @@ tsq.q
                  ${repoFilterParam2}
                ORDER BY bm25_score DESC
                LIMIT GREATEST(150, $3 * 20)
            ),
            lexical_matches AS (
                SELECT
                    l.id,
                    l.bm25_score,
                    ROW_NUMBER() OVER (ORDER BY l.bm25_score DESC) AS bm25_rank
                FROM lexical_raw l
                WHERE l.file_path IS NULL OR NOT EXISTS (
                    SELECT 1 FROM blobs b2
                    WHERE b2.repository_id = l.repository_id
                      AND b2.file_path = l.file_path
                      AND (
                          COALESCE(b2.last_seen_at, b2.created_at, '-infinity'::timestamptz) > COALESCE(l.last_seen_at, l.created_at, '-infinity'::timestamptz)
                          OR (
                              COALESCE(b2.last_seen_at, b2.created_at, '-infinity'::timestamptz) = COALESCE(l.last_seen_at, l.created_at, '-infinity'::timestamptz)
                              AND b2.id > l.id
                          )
                      )
                )
                ORDER BY l.bm25_score DESC
                LIMIT GREATEST(60, $3 * 10)
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
                b.symbol_spine,
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
        const params = [vectorStr, scopedRepoId, safeLimit, textQuery, expandedQuery, activeModel];
        const res = await queryWithLegacySchemaFallback(sql, params, () => ({
            sql: sql
                .replace(/\s*AND \(b\.embed_model IS NULL OR b\.embed_model = \$6\)/g, '')
                .replace(/b\.symbol_spine,/g, 'NULL::text AS symbol_spine,'),
            params: [vectorStr, scopedRepoId, safeLimit, textQuery, expandedQuery]
        }));
        if (res.rows.length > 0) {
            const calibratedRows = res.rows.map((row) => ({
                ...row,
                dense_sim: Number(row.dense_sim) > 0
                    ? calibrateQuerySimilarity(Number(row.dense_sim), { model: activeModel, queryVec: vector })
                    : 0
            }));
            if (shouldBridge) {
                return await expandCodeGraphBridges(calibratedRows, textQuery, {
                    queryFn: query,
                    repositoryId: scopedRepoId,
                    limit: safeLimit
                });
            }
            return calibratedRows;
        }
        // If hybrid yielded 0 rows, fall through to dense search
    }

    // 2. DENSE SEMANTIC SEARCH (Pure vector — HNSW + B-Tree NOT EXISTS latest-blob deduplication)
    if (vector) {
        const vectorStr = `[${vector.join(',')}]`;
        const sql = `
            WITH ann_raw AS MATERIALIZED (
                SELECT 
                    b.id,
                    b.repository_id,
                    b.summary,
                    b.symbol_spine,
                    b.storage_mode,
                    b.last_seen_at,
                    b.created_at,
                    b.file_name,
                    b.file_path,
                    (b.embedding <=> $1::vector) AS cosine_dist
                FROM blobs b
                WHERE b.embedding IS NOT NULL
                  AND (b.embed_model IS NULL OR b.embed_model = $4)
                  ${repoFilterParam2}
                ORDER BY b.embedding <=> $1::vector ASC
                LIMIT GREATEST(150, $3 * 20)
            ),
            ann_candidates AS (
                SELECT *
                FROM ann_raw a
                WHERE a.file_path IS NULL OR NOT EXISTS (
                    SELECT 1 FROM blobs b2
                    WHERE b2.repository_id = a.repository_id
                      AND b2.file_path = a.file_path
                      AND (
                          COALESCE(b2.last_seen_at, b2.created_at, '-infinity'::timestamptz) > COALESCE(a.last_seen_at, a.created_at, '-infinity'::timestamptz)
                          OR (
                              COALESCE(b2.last_seen_at, b2.created_at, '-infinity'::timestamptz) = COALESCE(a.last_seen_at, a.created_at, '-infinity'::timestamptz)
                              AND b2.id > a.id
                          )
                      )
                )
                ORDER BY a.cosine_dist ASC
                LIMIT GREATEST(60, $3 * 10)
            )
            SELECT 
                c.id,
                c.repository_id,
                r.name AS project,
                COALESCE(c.summary, substring(encode(full_b.content, 'escape') from 1 for 500)) AS summary,
                c.symbol_spine,
                c.storage_mode,
                c.last_seen_at,
                COALESCE(c.file_name, c.id) AS file_name,
                c.file_path,
                (1 - c.cosine_dist) AS raw_dense_sim,
                exp(-0.01 * EXTRACT(EPOCH FROM (CURRENT_TIMESTAMP - COALESCE(c.last_seen_at, c.created_at))) / 86400.0) AS decay_factor,
                (1 - c.cosine_dist) 
                    * exp(-0.01 * EXTRACT(EPOCH FROM (CURRENT_TIMESTAMP - COALESCE(c.last_seen_at, c.created_at))) / 86400.0)
                AS similarity
            FROM ann_candidates c
            JOIN blobs full_b ON full_b.id = c.id
            JOIN repositories r ON r.id = c.repository_id
            ORDER BY similarity DESC
            LIMIT $3;
        `;
        const params = [vectorStr, scopedRepoId, safeLimit, activeModel];
        const res = await queryWithLegacySchemaFallback(sql, params, () => ({
            sql: sql
                .replace(/\s*AND \(b\.embed_model IS NULL OR b\.embed_model = \$4\)/g, '')
                .replace(/b\.symbol_spine,/g, 'NULL::text AS symbol_spine,')
                .replace(/c\.symbol_spine,/g, 'NULL::text AS symbol_spine,'),
            params: [vectorStr, scopedRepoId, safeLimit]
        }));
        if (res.rows.length > 0 || !textQuery) {
            const calibratedRows = res.rows.map((row) => {
                const rawDense = row.raw_dense_sim !== undefined
                    ? Number(row.raw_dense_sim)
                    : Number(row.similarity || 0);
                const decay = row.decay_factor !== undefined ? Number(row.decay_factor) : 1.0;
                const calibratedDense = calibrateQuerySimilarity(rawDense, {
                    model: activeModel,
                    queryVec: vector
                });
                const rest = { ...row };
                delete rest.raw_dense_sim;
                delete rest.decay_factor;
                return {
                    ...rest,
                    dense_sim: calibratedDense,
                    similarity: calibratedDense * decay
                };
            });
            if (shouldBridge && calibratedRows.length > 0) {
                return await expandCodeGraphBridges(calibratedRows, textQuery, {
                    queryFn: query,
                    repositoryId: scopedRepoId,
                    limit: safeLimit
                });
            }
            return calibratedRows;
        }
    }

    // 3. LEXICAL BM25 SEARCH (Fallback or pure keyword — single combined tsquery + B-Tree NOT EXISTS latest-blob deduplication)
    if (textQuery) {
        const escapedLike = textQuery.replace(/[_%]/g, '\\$&');
        const sql = `
            WITH tsq AS MATERIALIZED (
                SELECT (
                    plainto_tsquery('simple', $1)
                    || plainto_tsquery('english', $1)
                    || CASE WHEN $3 <> '' THEN websearch_to_tsquery('english', $3) ELSE ''::tsquery END
                ) AS q
            ),
            lexical_raw AS MATERIALIZED (
                SELECT
                    b.id,
                    b.repository_id,
                    b.summary,
                    b.symbol_spine,
                    b.storage_mode,
                    b.last_seen_at,
                    b.created_at,
                    b.file_name,
                    b.file_path,
                    (
                        GREATEST(
                            COALESCE(ts_rank_cd(b.tsv, plainto_tsquery('simple', $1)), 0.0) * 1.5 +
                            COALESCE(ts_rank_cd(b.tsv, plainto_tsquery('english', $1)), 0.0) * 1.25 +
                            CASE
                                WHEN $3 <> '' THEN COALESCE(ts_rank_cd(b.tsv, websearch_to_tsquery('english', $3)), 0.0)
                                ELSE 0.0
                            END,
                            0.1
                        ) * exp(-0.01 * EXTRACT(EPOCH FROM (CURRENT_TIMESTAMP - COALESCE(b.last_seen_at, b.created_at))) / 86400.0)
                    ) AS similarity
                FROM blobs b, tsq
                WHERE (
                    (tsq.q <> ''::tsquery AND b.tsv @@ tsq.q)
                    OR b.file_name ILIKE '%' || $2 || '%'
                    OR b.file_path ILIKE '%' || $2 || '%'
                )
                  ${repoFilterParam4}
                ORDER BY similarity DESC
                LIMIT GREATEST(150, $5 * 20)
            )
            SELECT
                l.id,
                l.repository_id,
                r.name AS project,
                COALESCE(l.summary, substring(encode(full_b.content, 'escape') from 1 for 500)) AS summary,
                l.symbol_spine,
                l.storage_mode,
                l.last_seen_at,
                COALESCE(l.file_name, l.id) AS file_name,
                l.file_path,
                l.similarity
            FROM lexical_raw l
            JOIN blobs full_b ON full_b.id = l.id
            JOIN repositories r ON r.id = l.repository_id
            WHERE l.file_path IS NULL OR NOT EXISTS (
                SELECT 1 FROM blobs b2
                WHERE b2.repository_id = l.repository_id
                  AND b2.file_path = l.file_path
                  AND (
                      COALESCE(b2.last_seen_at, b2.created_at, '-infinity'::timestamptz) > COALESCE(l.last_seen_at, l.created_at, '-infinity'::timestamptz)
                      OR (
                          COALESCE(b2.last_seen_at, b2.created_at, '-infinity'::timestamptz) = COALESCE(l.last_seen_at, l.created_at, '-infinity'::timestamptz)
                          AND b2.id > l.id
                      )
                  )
            )
            ORDER BY l.similarity DESC
            LIMIT $5;
        `;
        const params = [textQuery, escapedLike, expandedQuery, scopedRepoId, safeLimit];
        const res = await queryWithLegacySchemaFallback(sql, params, () => ({
            sql: sql
                .replace(/b\.symbol_spine,/g, 'NULL::text AS symbol_spine,')
                .replace(/l\.symbol_spine,/g, 'NULL::text AS symbol_spine,'),
            params
        }));
        if (shouldBridge && res.rows.length > 0) {
            return await expandCodeGraphBridges(res.rows, textQuery, {
                queryFn: query,
                repositoryId: scopedRepoId,
                limit: safeLimit
            });
        }
        return res.rows;
    }

    return [];
}

/**
 * Resolve exact code snippet for a symbol on demand from local disk pointer when
 * code_symbols.content is null or stores compact '[POINTER_TOKENS]' FTS index tokens.
 * Supports an optional per-batch fileCache Map to prevent redundant disk reads.
 */
export async function resolveSymbolSnippet(symbol, fileCache = null) {
    if (!symbol) return null;
    const rawContent = symbol.content ? String(symbol.content) : '';
    const isPointerTokens = rawContent.startsWith('[POINTER_TOKENS]');

    if (rawContent && !isPointerTokens) {
        return rawContent;
    }

    if (symbol.file_path && (symbol.project || symbol.repository_id)) {
        const cacheKey = `${symbol.repository_id || ''}::${symbol.project || ''}::${symbol.file_path}`;
        let buf;
        if (fileCache && fileCache.has(cacheKey)) {
            buf = await fileCache.get(cacheKey);
        } else {
            const readPromise = resolveBlobContent({
                id: symbol.blob_id || `sym-${symbol.id || '0'}`,
                repository_id: symbol.repository_id,
                project: symbol.project,
                file_path: symbol.file_path,
                storage_mode: 'pointer'
            });
            if (fileCache) fileCache.set(cacheKey, readPromise);
            buf = await readPromise;
        }
        if (buf) {
            const text = buf.toString('utf-8');
            const lines = text.split('\n');
            const startIdx = Math.max(0, (Number(symbol.start_line) || 1) - 1);
            const endIdx = Math.min(lines.length, Number(symbol.end_line) || (startIdx + 25));
            const sliced = lines.slice(startIdx, endIdx).join('\n');
            if (sliced.trim().length > 0) {
                return sliced;
            }
        }
    }

    if (isPointerTokens) {
        return symbol.signature || rawContent.replace(/^\[POINTER_TOKENS\]\n?/, '');
    }
    return symbol.signature || null;
}

/**
 * Search code symbols (functions, classes, methods, routes, sections) across repositories.
 * Matches exact symbol names first, then prefix/substring (pg_trgm), then full-text simple tsv.
 * 
 * @param {string} queryText - The symbol name or query.
 * @param {number} limit - Maximum symbols to return.
 * @param {number|null} repositoryId - Optional repository filter.
 * @param {object} options - Optional filters { symbol_type: 'function'|'class'|'method'|'route'|'section' }.
 * @returns {Promise<Array>}
 */
export async function searchSymbols(queryText, limit = 10, repositoryId = null, options = {}) {
    const rawQuery = String(queryText || '').trim();
    if (!rawQuery) return [];

    const symbolType = options.symbol_type || null;
    const escapedLike = rawQuery.replace(/[_%]/g, '\\$&');
    const safeLimit = Math.max(1, Math.min(Number(limit) || 10, 100));
    
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
            s.symbol_hash,
            (
                CASE 
                    WHEN LOWER(s.symbol_name) = LOWER($1) THEN 1.0
                    WHEN s.symbol_name ILIKE '%' || $2 || '%' THEN 0.85
                    ELSE COALESCE(ts_rank_cd(s.tsv, plainto_tsquery('simple', $1)), 0.1)
                END
            ) AS similarity
        FROM code_symbols s
        JOIN repositories r ON r.id = s.repository_id
        WHERE (
            LOWER(s.symbol_name) = LOWER($1)
            OR s.symbol_name ILIKE '%' || $2 || '%'
            OR s.tsv @@ plainto_tsquery('simple', $1)
        )
    `;
    const params = [rawQuery, escapedLike];
    if (repositoryId) {
        params.push(repositoryId);
        sql += ` AND s.repository_id = $${params.length}`;
    }
    if (symbolType) {
        params.push(symbolType);
        sql += ` AND s.symbol_type = $${params.length}`;
    }
    params.push(safeLimit * 2);
    sql += ` ORDER BY similarity DESC, s.id DESC, s.start_line ASC LIMIT $${params.length}`;

    const res = await query(sql, params);

    // Deduplicate by (repository_id, file_path, symbol_name, symbol_type, start_line) keeping newest
    const seen = new Set();
    const uniqueRows = [];
    for (const row of res.rows) {
        const key = `${row.repository_id}:${row.file_path}:${row.symbol_name}:${row.symbol_type}:${row.start_line}`;
        if (!seen.has(key)) {
            seen.add(key);
            uniqueRows.push(row);
            if (uniqueRows.length >= safeLimit) break;
        }
    }

    // Supplement with HNSW dense AST symbol search (idx_code_symbols_embedding) when lexical matches are empty or sparse
    if (options.semantic !== false && uniqueRows.length < safeLimit && (uniqueRows.length === 0 || rawQuery.includes(' '))) {
        try {
            const qVec = await getEmbedding(rawQuery, PRIORITY.HIGH, { mode: 'query' });
            if (Array.isArray(qVec) && qVec.length > 0) {
                const activeModel = getActiveEmbedModel();
                const vecLiteral = `[${qVec.join(',')}]`;
                const semParams = [vecLiteral, activeModel];
                let semSql = `
                    SELECT
                        sym.id,
                        sym.blob_id,
                        sym.repository_id,
                        r.name AS project,
                        sym.file_path,
                        sym.symbol_name,
                        sym.symbol_type,
                        sym.start_line,
                        sym.end_line,
                        sym.signature,
                        sym.content,
                        sym.symbol_hash,
                        (1 - (sym.embedding <=> $1::vector)) AS similarity
                    FROM code_symbols sym
                    JOIN repositories r ON r.id = sym.repository_id
                    WHERE sym.embedding IS NOT NULL
                      AND (sym.embed_model IS NULL OR sym.embed_model = $2)
                `;
                if (repositoryId) {
                    semParams.push(repositoryId);
                    semSql += ` AND sym.repository_id = $${semParams.length}`;
                }
                if (symbolType) {
                    semParams.push(symbolType);
                    semSql += ` AND sym.symbol_type = $${semParams.length}`;
                }
                semParams.push((safeLimit - uniqueRows.length) * 2);
                semSql += ` ORDER BY sym.embedding <=> $1::vector ASC LIMIT $${semParams.length}`;
                const semRes = await queryWithLegacySchemaFallback(semSql, semParams, () => {
                    const legacyParams = [vecLiteral];
                    let legacySql = `
                        SELECT
                            sym.id,
                            sym.blob_id,
                            sym.repository_id,
                            r.name AS project,
                            sym.file_path,
                            sym.symbol_name,
                            sym.symbol_type,
                            sym.start_line,
                            sym.end_line,
                            sym.signature,
                            sym.content,
                            sym.symbol_hash,
                            (1 - (sym.embedding <=> $1::vector)) AS similarity
                        FROM code_symbols sym
                        JOIN repositories r ON r.id = sym.repository_id
                        WHERE sym.embedding IS NOT NULL
                    `;
                    if (repositoryId) {
                        legacyParams.push(repositoryId);
                        legacySql += ` AND sym.repository_id = $${legacyParams.length}`;
                    }
                    if (symbolType) {
                        legacyParams.push(symbolType);
                        legacySql += ` AND sym.symbol_type = $${legacyParams.length}`;
                    }
                    legacyParams.push((safeLimit - uniqueRows.length) * 2);
                    legacySql += ` ORDER BY sym.embedding <=> $1::vector ASC LIMIT $${legacyParams.length}`;
                    return { sql: legacySql, params: legacyParams };
                });
                for (const row of semRes.rows) {
                    const rawSim = Number(row.similarity);
                    const calibratedSim = calibrateQuerySimilarity(rawSim, { model: activeModel, queryVec: qVec });
                    if (rawSim < 0.35 && calibratedSim < 0.55) continue;
                    const key = `${row.repository_id}:${row.file_path}:${row.symbol_name}:${row.symbol_type}:${row.start_line}`;
                    if (!seen.has(key)) {
                        seen.add(key);
                        uniqueRows.push({
                            ...row,
                            raw_similarity: rawSim,
                            similarity: calibratedSim
                        });
                        if (uniqueRows.length >= safeLimit) break;
                    }
                }
            }
        } catch (err) {
            console.warn(`[searchSymbols] Semantic symbol fallback skipped: ${err.message}`);
        }
    }

    const fileCache = new Map();
    const hydrated = await Promise.all(
        uniqueRows.map(async (row) => {
            let content = row.content;
            if (!content || String(content).startsWith('[POINTER_TOKENS]')) {
                content = await resolveSymbolSnippet(row, fileCache);
            }
            const symbol_hash = row.symbol_hash || computeSymbolHash(content || row.signature || row.symbol_name);
            return { ...row, content, symbol_hash };
        })
    );
    return hydrated;
}

/**
 * Get all symbols defined in a given blob/file.
 * 
 * @param {string} blobId - The SHA-1 hash of the blob.
 * @returns {Promise<Array>}
 */
export async function getSymbolsForBlob(blobId) {
    if (!blobId) return [];
    const res = await query(`
        SELECT s.*, r.name AS project
        FROM code_symbols s
        JOIN repositories r ON r.id = s.repository_id
        WHERE s.blob_id = $1
        ORDER BY s.start_line ASC
    `, [blobId]);
    const fileCache = new Map();
    return Promise.all(
        res.rows.map(async (row) => {
            let content = row.content;
            if (!content || String(content).startsWith('[POINTER_TOKENS]')) {
                content = await resolveSymbolSnippet(row, fileCache);
            }
            const symbol_hash = row.symbol_hash || computeSymbolHash(content || row.signature || row.symbol_name);
            return {
                ...row,
                content,
                symbol_hash
            };
        })
    );
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
    const cleanFilePath = String(filePath || '').trim().replace(/^[/\\]+/, '');
    if (!cleanFilePath) {
        return { filePath: '', repositoryId, symbols: [], imports: [], dependents: [] };
    }

    // Outbound imports (deduplicated by target_path + relation)
    const importsRes = await query(`
        SELECT DISTINCT ON (target_path, relation) target_path, relation, symbols
        FROM code_symbol_edges
        WHERE repository_id = $1 AND (source_path = $2 OR source_path = $3)
        ORDER BY target_path ASC, relation ASC, id DESC
    `, [repositoryId, cleanFilePath, filePath]);

    // Inbound dependents (files that import this file)
    const fileBase = path.posix.basename(cleanFilePath);
    const baseName = path.posix.basename(cleanFilePath, path.posix.extname(cleanFilePath));
    const dirName = path.posix.dirname(cleanFilePath);
    const escapedCleanPath = cleanFilePath.replace(/[_%]/g, '\\$&');
    const escapedBaseName = baseName.replace(/[_%]/g, '\\$&');
    const isGeneric = ['index', 'main', 'app', 'utils', 'config', 'test', 'types', 'mod', 'lib'].includes(baseName.toLowerCase());

    let dependentsRes;
    if (isGeneric || !baseName) {
        const sameDirRelCandidates = [`./${fileBase}`, `./${baseName}`];
        if (dirName && dirName !== '.') {
            const escapedDirPrefix = dirName.replace(/[_%]/g, '\\$&') + '/%';
            const dirPlusBase = `${dirName}/${baseName}`.replace(/[_%]/g, '\\$&');
            dependentsRes = await query(`
                SELECT DISTINCT ON (source_path, relation) source_path, relation, symbols
                FROM code_symbol_edges
                WHERE repository_id = $1 
                  AND (
                      target_path = $2
                      OR target_path ILIKE '%' || $3
                      OR target_path ILIKE '%' || $4
                      OR (source_path ILIKE $5 AND target_path = ANY($6))
                  )
                ORDER BY source_path ASC, relation ASC, id DESC
            `, [repositoryId, cleanFilePath, escapedCleanPath, dirPlusBase, escapedDirPrefix, sameDirRelCandidates]);
        } else {
            dependentsRes = await query(`
                SELECT DISTINCT ON (source_path, relation) source_path, relation, symbols
                FROM code_symbol_edges
                WHERE repository_id = $1 
                  AND (
                      target_path = $2
                      OR target_path ILIKE '%/' || $3
                      OR target_path = ANY($4)
                  )
                ORDER BY source_path ASC, relation ASC, id DESC
            `, [repositoryId, cleanFilePath, escapedCleanPath, sameDirRelCandidates]);
        }
    } else {
        dependentsRes = await query(`
            SELECT DISTINCT ON (source_path, relation) source_path, relation, symbols
            FROM code_symbol_edges
            WHERE repository_id = $1 
              AND (
                  target_path = $2
                  OR target_path ILIKE '%' || $3
                  OR target_path ILIKE '%' || $4 || '%'
              )
            ORDER BY source_path ASC, relation ASC, id DESC
        `, [repositoryId, cleanFilePath, escapedCleanPath, escapedBaseName]);
    }

    // File's own symbols (deduplicated by symbol_name, symbol_type, start_line)
    const symbolsRes = await query(`
        SELECT DISTINCT ON (start_line, symbol_name, symbol_type)
            symbol_name, symbol_type, start_line, end_line, signature, symbol_hash
        FROM code_symbols
        WHERE repository_id = $1 AND (file_path = $2 OR file_path = $3)
        ORDER BY start_line ASC, symbol_name ASC, symbol_type ASC, id DESC
    `, [repositoryId, cleanFilePath, filePath]);

    return {
        filePath: cleanFilePath,
        repositoryId,
        symbols: symbolsRes.rows,
        imports: importsRes.rows,
        dependents: dependentsRes.rows
    };
}



