/**
 * Hermetic in-memory database fixture for krusch-git (BUG-01, DX-01 & INV-GIT-SEARCH-03.5).
 * Used automatically when KRUSCH_EPHEMERAL=1 or when PostgreSQL is unreachable /
 * unauthenticated in test/CI environments.
 */

import path from 'node:path';

function splitTopLevelCsv(input) {
    const parts = [];
    let current = '';
    let depthParen = 0;
    let depthBracket = 0;
    let inSingleQuote = false;

    for (let i = 0; i < input.length; i++) {
        const ch = input[i];
        if (inSingleQuote) {
            current += ch;
            if (ch === "'") {
                if (input[i + 1] === "'") {
                    current += "'";
                    i++;
                } else {
                    inSingleQuote = false;
                }
            }
            continue;
        }
        if (ch === "'") {
            inSingleQuote = true;
            current += ch;
            continue;
        }
        if (ch === '(') depthParen++;
        else if (ch === ')' && depthParen > 0) depthParen--;
        else if (ch === '[') depthBracket++;
        else if (ch === ']' && depthBracket > 0) depthBracket--;

        if (ch === ',' && depthParen === 0 && depthBracket === 0) {
            parts.push(current.trim());
            current = '';
        } else {
            current += ch;
        }
    }
    if (current.trim().length > 0) {
        parts.push(current.trim());
    }
    return parts;
}

function extractValueTuples(valuesClause) {
    const tuples = [];
    let depth = 0;
    let start = -1;
    let inSingleQuote = false;

    for (let i = 0; i < valuesClause.length; i++) {
        const ch = valuesClause[i];
        if (inSingleQuote) {
            if (ch === "'") {
                if (valuesClause[i + 1] === "'") {
                    i++;
                } else {
                    inSingleQuote = false;
                }
            }
            continue;
        }
        if (ch === "'") {
            inSingleQuote = true;
            continue;
        }
        if (ch === '(') {
            if (depth === 0) start = i + 1;
            depth++;
        } else if (ch === ')') {
            depth--;
            if (depth === 0 && start !== -1) {
                tuples.push(valuesClause.slice(start, i));
                start = -1;
            }
        }
    }
    return tuples;
}

function resolveSqlExpr(expr, params) {
    const trimmed = String(expr || '').trim();
    const paramMatch = trimmed.match(/^\$(\d+)(?:::[a-zA-Z0-9_\[\]]+)?$/);
    if (paramMatch) {
        return params[Number(paramMatch[1]) - 1];
    }
    if (/^NULL(?:::[a-zA-Z0-9_\[\]]+)?$/i.test(trimmed)) {
        return null;
    }
    if (/^CURRENT_TIMESTAMP$/i.test(trimmed) || /^NOW\(\)$/i.test(trimmed)) {
        return new Date();
    }
    const intervalMatch = trimmed.match(/^(?:NOW\(\)|CURRENT_TIMESTAMP)\s*([+-])\s*INTERVAL\s*'(\d+(?:\.\d+)?)\s*(day|days|hour|hours|minute|minutes|second|seconds)'$/i);
    if (intervalMatch) {
        const sign = intervalMatch[1] === '-' ? -1 : 1;
        const amount = Number(intervalMatch[2]);
        const unit = intervalMatch[3].toLowerCase();
        const unitMs = unit.startsWith('day')
            ? 86400000
            : (unit.startsWith('hour') ? 3600000 : (unit.startsWith('minute') ? 60000 : 1000));
        return new Date(Date.now() + sign * amount * unitMs);
    }
    if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
        return trimmed.slice(1, -1).replace(/''/g, "'");
    }
    const arrayMatch = trimmed.match(/^ARRAY\[(.*)\]$/i);
    if (arrayMatch) {
        return splitTopLevelCsv(arrayMatch[1]).map((item) => resolveSqlExpr(item, params));
    }
    if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) {
        return Number(trimmed);
    }
    return trimmed;
}

function parseInsertTuples(sql, params) {
    const headerMatch = sql.match(/INSERT\s+INTO\s+[a-zA-Z0-9_]+\s*\(([^)]+)\)\s*VALUES\s*([\s\S]+?)(?:\s+ON\s+CONFLICT|\s+RETURNING|;?\s*$)/i);
    if (!headerMatch) return null;
    const cols = splitTopLevelCsv(headerMatch[1]).map((c) => c.trim().toLowerCase());
    const tupleStrings = extractValueTuples(headerMatch[2]);
    return tupleStrings.map((tupleStr) => {
        const exprs = splitTopLevelCsv(tupleStr);
        const mapped = {};
        for (let i = 0; i < cols.length; i++) {
            mapped[cols[i]] = resolveSqlExpr(exprs[i], params);
        }
        return mapped;
    });
}

function tokenizeQueryTerms(textQuery) {
    if (!textQuery) return [];
    const splitCamel = String(textQuery)
        .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .toLowerCase();
    const rawTokens = splitCamel.split(/[^a-z0-9]+/).filter((t) => t.length >= 2);
    const stop = new Set(['the', 'and', 'for', 'with', 'from', 'how', 'what', 'where', 'in', 'on', 'to', 'of', 'is', 'are', 'or']);
    const filtered = rawTokens.filter((t) => !stop.has(t));
    return filtered.length > 0 ? filtered : rawTokens;
}

function stemSimpleEnglish(word) {
    if (!word || word.length < 4) return word;
    if (word.endsWith('ies') && word.length >= 5) return `${word.slice(0, -3)}y`;
    if (word.endsWith('es') && word.length >= 5 && /(?:ches|shes|xes|zes|ses)$/.test(word)) return word.slice(0, -2);
    if (word.endsWith('s') && !word.endsWith('ss') && !word.endsWith('us') && !word.endsWith('is')) return word.slice(0, -1);
    return word;
}

function scoreBlobLexical(blob, rawTextQuery) {
    if (!rawTextQuery) return { matched: true, score: 0.5 };
    const terms = tokenizeQueryTerms(rawTextQuery);
    if (terms.length === 0) return { matched: false, score: 0 };

    const rawHay = [
        blob.file_name || '',
        blob.file_path || '',
        blob.symbol_spine || '',
        blob.summary || '',
        blob.content ? blob.content.toString('utf8') : ''
    ].join(' ');
    const splitHay = rawHay
        .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .toLowerCase();
    const hayLower = rawHay.toLowerCase();

    let hits = 0;
    for (const term of terms) {
        const stem = stemSimpleEnglish(term);
        if (
            hayLower.includes(term) ||
            splitHay.includes(term) ||
            (stem.length >= 3 && (hayLower.includes(stem) || splitHay.includes(stem)))
        ) {
            hits++;
        }
    }
    if (hits === 0) return { matched: false, score: 0 };
    return { matched: true, score: 0.25 + (hits / terms.length) * 0.75 };
}

function normalizePosixRelPath(p) {
    return String(p || '').trim().replace(/^[/\\]+/, '');
}

function edgeResolvesToPath(sourcePath, targetPath, candidateFilePath) {
    const src = normalizePosixRelPath(sourcePath);
    const tgt = String(targetPath || '').trim();
    const cand = normalizePosixRelPath(candidateFilePath);
    if (!src || !tgt || !cand || src === cand) return false;
    if (tgt.startsWith('node:')) return false;

    const matchTarget = (resolved) => {
        const clean = resolved.replace(/^\.\//, '');
        if (!clean) return false;
        return (
            cand === clean ||
            cand.startsWith(`${clean}.`) ||
            cand === `${clean}/index.js` ||
            cand === `${clean}/index.ts`
        );
    };

    if (tgt.startsWith('./') || tgt.startsWith('../')) {
        const srcDir = path.posix.dirname(src);
        const joined = path.posix.normalize(path.posix.join(srcDir === '.' ? '' : srcDir, tgt));
        if (!joined.startsWith('..')) {
            return matchTarget(joined);
        }
        const stripped = tgt.replace(/^(?:\.\.?\/)+/, '');
        return cand === stripped || cand.endsWith(`/${stripped}`) || cand.endsWith(`/${stripped}.js`) || cand.endsWith(`/${stripped}.ts`);
    }

    const cleanBare = normalizePosixRelPath(tgt);
    return (
        matchTarget(cleanBare) ||
        cand.endsWith(`/${cleanBare}`) ||
        cand.endsWith(`/${cleanBare}.js`) ||
        cand.endsWith(`/${cleanBare}.ts`) ||
        cand.endsWith(`/${cleanBare}.py`)
    );
}

export function createMockDbPool() {
    let nextRepoId = 2;
    let nextSymbolId = 2;
    let nextEdgeId = 2;

    const repositories = new Map([
        [1, {
            id: 1,
            name: 'krusch-git',
            description: 'Hermetic baseline repository',
            created_at: new Date()
        }]
    ]);

    const blobs = new Map([
        ['seed-git-engine-blob-00000000000000000000', {
            id: 'seed-git-engine-blob-00000000000000000000',
            repository_id: 1,
            content: null,
            size: 1024,
            file_name: 'git-engine.js',
            file_path: 'server/git-engine.js',
            summary: 'Core git engine with searchBlobs and symbol graph',
            symbol_spine: 'searchBlobs searchSymbols getSymbolGraph',
            storage_mode: 'pointer',
            embedding: new Array(1024).fill(0.01),
            embed_model: null,
            last_seen_at: new Date(),
            created_at: new Date()
        }]
    ]);

    const codeSymbols = [
        {
            id: 1,
            blob_id: 'seed-git-engine-blob-00000000000000000000',
            repository_id: 1,
            file_path: 'server/git-engine.js',
            symbol_name: 'searchBlobs',
            symbol_type: 'function',
            start_line: 163,
            end_line: 342,
            signature: 'export async function searchBlobs(queryOrVector, limit = 5, repositoryId, options = {})',
            content: 'export async function searchBlobs(queryOrVector, limit = 5, repositoryId, options = {}) {}',
            symbol_hash: '30ea3e3ce9a5',
            embedding: null,
            embed_model: null
        }
    ];

    const codeSymbolEdges = [
        {
            id: 1,
            repository_id: 1,
            source_blob_id: 'seed-git-engine-blob-00000000000000000000',
            source_path: 'server/mcp.js',
            target_path: './git-engine.js',
            relation: 'imports',
            symbols: ['searchBlobs', 'searchSymbols']
        }
    ];

    function parseVector(vecParam) {
        if (vecParam === null || vecParam === undefined) return null;
        if (Array.isArray(vecParam)) return vecParam.map(Number);
        if (typeof vecParam === 'string') {
            const cleaned = vecParam.trim().replace(/^\[|\]$/g, '');
            if (!cleaned) return [];
            return cleaned.split(',').map(Number);
        }
        return null;
    }

    function cosineSimilarity(a, b) {
        if (!a || !b || a.length === 0 || b.length === 0) return 0;
        const len = Math.min(a.length, b.length);
        let dot = 0;
        let normA = 0;
        let normB = 0;
        for (let i = 0; i < len; i++) {
            dot += a[i] * b[i];
            normA += a[i] * a[i];
            normB += b[i] * b[i];
        }
        if (normA === 0 || normB === 0) return 0;
        return dot / (Math.sqrt(normA) * Math.sqrt(normB));
    }

    function computeDecayFactor(blob) {
        const ts = blob.last_seen_at || blob.created_at;
        if (!ts) return 1.0;
        const ageDays = Math.max(0, (Date.now() - new Date(ts).getTime()) / 86400000);
        return Math.exp(-0.01 * ageDays);
    }

    function getLatestDeduplicatedBlobs(repoIdFilter = null) {
        const latestByRepoPath = new Map();
        const nullPathBlobs = [];

        for (const b of blobs.values()) {
            if (repoIdFilter !== null && !Number.isNaN(repoIdFilter) && Number(b.repository_id) !== repoIdFilter) {
                continue;
            }
            if (b.file_path === null || b.file_path === undefined || b.file_path === '') {
                nullPathBlobs.push(b);
                continue;
            }
            const key = `${Number(b.repository_id)}::${b.file_path}`;
            const prev = latestByRepoPath.get(key);
            if (!prev) {
                latestByRepoPath.set(key, b);
                continue;
            }
            const curTime = new Date(b.last_seen_at || b.created_at || 0).getTime();
            const prevTime = new Date(prev.last_seen_at || prev.created_at || 0).getTime();
            if (curTime > prevTime || (curTime === prevTime && String(b.id) > String(prev.id))) {
                latestByRepoPath.set(key, b);
            }
        }

        return [...latestByRepoPath.values(), ...nullPathBlobs];
    }

    async function query(sqlText, params = []) {
        const sql = String(sqlText || '').trim();
        const norm = sql.replace(/\s+/g, ' ').toUpperCase();

        if (norm === 'SELECT 1') {
            return { rows: [{ '?column?': 1 }], rowCount: 1 };
        }

        if (norm === 'BEGIN' || norm === 'COMMIT' || norm === 'ROLLBACK') {
            return { rows: [], rowCount: 0 };
        }

        // INSERT INTO repositories
        if (norm.startsWith('INSERT INTO REPOSITORIES')) {
            const name = String(params[0] ?? '').trim();
            const description = String(params[1] ?? '');
            for (const existing of repositories.values()) {
                if (existing.name === name) {
                    const dupErr = new Error(`duplicate key value violates unique constraint "repositories_name_key"`);
                    dupErr.code = '23505';
                    throw dupErr;
                }
            }
            const id = nextRepoId++;
            const row = { id, name, description, created_at: new Date() };
            repositories.set(id, row);
            return { rows: [row], rowCount: 1 };
        }

        // DELETE FROM repositories WHERE id = $1
        if (norm.startsWith('DELETE FROM REPOSITORIES')) {
            const repoId = Number(params[0]);
            const existed = repositories.delete(repoId);
            for (const [bId, b] of blobs.entries()) {
                if (Number(b.repository_id) === repoId) blobs.delete(bId);
            }
            for (let i = codeSymbols.length - 1; i >= 0; i--) {
                if (Number(codeSymbols[i].repository_id) === repoId) codeSymbols.splice(i, 1);
            }
            for (let i = codeSymbolEdges.length - 1; i >= 0; i--) {
                if (Number(codeSymbolEdges[i].repository_id) === repoId) codeSymbolEdges.splice(i, 1);
            }
            return { rows: [], rowCount: existed ? 1 : 0 };
        }

        // DELETE FROM code_symbols
        if (norm.startsWith('DELETE FROM CODE_SYMBOLS')) {
            const sha = String(params[0] ?? '');
            const repoId = Number(params[1]);
            const relPath = String(params[2] ?? '');
            let deleted = 0;
            for (let i = codeSymbols.length - 1; i >= 0; i--) {
                const s = codeSymbols[i];
                if (Number(s.repository_id) === repoId && (s.blob_id === sha || (relPath && s.file_path === relPath))) {
                    codeSymbols.splice(i, 1);
                    deleted++;
                }
            }
            return { rows: [], rowCount: deleted };
        }

        // DELETE FROM code_symbol_edges
        if (norm.startsWith('DELETE FROM CODE_SYMBOL_EDGES')) {
            const sha = String(params[0] ?? '');
            const repoId = Number(params[1]);
            const relPath = String(params[2] ?? '');
            let deleted = 0;
            for (let i = codeSymbolEdges.length - 1; i >= 0; i--) {
                const e = codeSymbolEdges[i];
                if (Number(e.repository_id) === repoId && (e.source_blob_id === sha || (relPath && e.source_path === relPath))) {
                    codeSymbolEdges.splice(i, 1);
                    deleted++;
                }
            }
            return { rows: [], rowCount: deleted };
        }

        // SELECT ... FROM repositories
        if (norm.includes('FROM REPOSITORIES') && !norm.includes('JOIN REPOSITORIES')) {
            if (norm.includes("IN ('KRUSCH-GIT', 'PG-GIT', 'GIT')")) {
                const found = Array.from(repositories.values()).filter(r =>
                    ['krusch-git', 'pg-git', 'git'].includes(r.name)
                );
                return { rows: found, rowCount: found.length };
            }
            if (norm.includes('WHERE NAME = $1 OR NAME = $2 OR NAME = $3')) {
                const names = new Set(params.map(p => String(p || '')));
                const found = Array.from(repositories.values()).filter(r => names.has(r.name));
                return { rows: found.slice(0, 1), rowCount: Math.min(1, found.length) };
            }
            if (norm.includes('WHERE NAME = $1')) {
                const found = Array.from(repositories.values()).filter(r => r.name === String(params[0] ?? ''));
                return { rows: found.slice(0, 1), rowCount: Math.min(1, found.length) };
            }
            if (norm.includes('WHERE ID = $1')) {
                const repo = repositories.get(Number(params[0]));
                return { rows: repo ? [repo] : [], rowCount: repo ? 1 : 0 };
            }
            const all = Array.from(repositories.values()).sort((a, b) => b.id - a.id);
            return { rows: all, rowCount: all.length };
        }

        // INSERT INTO blobs
        if (norm.startsWith('INSERT INTO BLOBS')) {
            const parsed = parseInsertTuples(sql, params);
            if (parsed && parsed.length > 0) {
                const insertedRows = [];
                const isUpsert = norm.includes('ON CONFLICT');
                const isDoNothing = norm.includes('DO NOTHING');
                for (const colMap of parsed) {
                    const id = String(colMap.id ?? params[0]);
                    const prev = blobs.get(id);
                    if (prev && isDoNothing) {
                        continue;
                    }
                    const repository_id = Number(colMap.repository_id ?? prev?.repository_id ?? params[1]);
                    const hasFileMeta = colMap.file_name !== undefined || colMap.file_path !== undefined;
                    const storage_mode = colMap.storage_mode || prev?.storage_mode || (hasFileMeta ? 'pointer' : 'direct');
                    const hasExplicitEmbedding = Object.prototype.hasOwnProperty.call(colMap, 'embedding');
                    let embedding = null;
                    if (hasExplicitEmbedding) {
                        embedding = colMap.embedding != null ? parseVector(colMap.embedding) : null;
                    } else if (prev?.embedding) {
                        embedding = prev.embedding;
                    } else if (!isUpsert && storage_mode === 'pointer') {
                        embedding = new Array(1024).fill(0.01);
                    }

                    const row = {
                        id,
                        repository_id,
                        content: colMap.content !== undefined ? colMap.content : (prev?.content ?? null),
                        size: Number(colMap.size ?? prev?.size ?? 0),
                        storage_mode,
                        file_name: colMap.file_name ?? prev?.file_name ?? id,
                        file_path: colMap.file_path !== undefined ? colMap.file_path : (prev?.file_path ?? null),
                        summary: colMap.summary !== undefined ? (colMap.summary ?? prev?.summary ?? null) : (prev?.summary ?? null),
                        symbol_spine: colMap.symbol_spine !== undefined ? colMap.symbol_spine : (prev?.symbol_spine ?? null),
                        embedding,
                        embed_model: colMap.embed_model !== undefined ? colMap.embed_model : (prev?.embed_model ?? null),
                        last_seen_at: colMap.last_seen_at ? new Date(colMap.last_seen_at) : new Date(),
                        created_at: colMap.created_at ? new Date(colMap.created_at) : (prev?.created_at ?? new Date())
                    };
                    blobs.set(id, row);
                    insertedRows.push(row);
                }
                return { rows: insertedRows, rowCount: insertedRows.length };
            }
        }

        // UPDATE blobs
        if (norm.startsWith('UPDATE BLOBS SET')) {
            if (norm.includes('SYMBOL_SPINE = $2 WHERE ID = $1')) {
                const b = blobs.get(String(params[0]));
                if (!b) return { rows: [], rowCount: 0 };
                b.symbol_spine = params[1] ?? null;
                return { rows: [b], rowCount: 1 };
            }
            if (norm.includes('EMBEDDING = $1::VECTOR') && norm.includes('EMBED_MODEL = $2') && norm.includes('WHERE ID = $3')) {
                const b = blobs.get(String(params[2]));
                if (!b) return { rows: [], rowCount: 0 };
                b.embedding = parseVector(params[0]);
                b.embed_model = params[1] ?? null;
                return { rows: [b], rowCount: 1 };
            }
            if (norm.includes('LAST_SEEN_AT = CURRENT_TIMESTAMP') && norm.includes('WHERE ID = $1')) {
                const b = blobs.get(String(params[0]));
                if (!b) return { rows: [], rowCount: 0 };
                b.last_seen_at = new Date();
                if (!b.file_name && params[1]) b.file_name = params[1];
                if (!b.file_path && params[2]) b.file_path = params[2];
                return { rows: [b], rowCount: 1 };
            }
        }

        // Direct SELECT from blobs by ID (sync_to_pg.js insertBlob)
        if (norm.startsWith('SELECT ') && norm.includes('FROM BLOBS') && !norm.includes('JOIN REPOSITORIES') && norm.includes('WHERE ID = $1')) {
            const b = blobs.get(String(params[0]));
            return { rows: b ? [{ ...b }] : [], rowCount: b ? 1 : 0 };
        }

        // INSERT INTO code_symbols
        if (norm.startsWith('INSERT INTO CODE_SYMBOLS')) {
            const parsed = parseInsertTuples(sql, params);
            if (parsed && parsed.length > 0) {
                const inserted = [];
                for (const colMap of parsed) {
                    const sym = {
                        id: nextSymbolId++,
                        blob_id: colMap.blob_id ?? params[0],
                        repository_id: Number(colMap.repository_id ?? params[1]),
                        file_path: colMap.file_path ?? 'lib/test.js',
                        symbol_name: colMap.symbol_name ?? 'hermeticTestFunction',
                        symbol_type: colMap.symbol_type ?? 'function',
                        start_line: Number(colMap.start_line ?? 1),
                        end_line: Number(colMap.end_line ?? 10),
                        signature: colMap.signature ?? null,
                        content: colMap.content ?? null,
                        symbol_hash: colMap.symbol_hash ?? null,
                        embedding: colMap.embedding != null ? parseVector(colMap.embedding) : null,
                        embed_model: colMap.embed_model ?? null
                    };
                    codeSymbols.push(sym);
                    inserted.push(sym);
                }
                return { rows: inserted, rowCount: inserted.length };
            }
        }

        // INSERT INTO code_symbol_edges
        if (norm.startsWith('INSERT INTO CODE_SYMBOL_EDGES')) {
            const parsed = parseInsertTuples(sql, params);
            if (parsed && parsed.length > 0) {
                const inserted = [];
                for (const colMap of parsed) {
                    const rawSyms = colMap.symbols;
                    const edge = {
                        id: nextEdgeId++,
                        repository_id: Number(colMap.repository_id ?? params[0]),
                        source_blob_id: colMap.source_blob_id ?? params[1],
                        source_path: colMap.source_path ?? 'lib/test.js',
                        target_path: colMap.target_path ?? 'lib/dep.js',
                        relation: colMap.relation || 'imports',
                        symbols: Array.isArray(rawSyms) ? rawSyms : (rawSyms != null ? [String(rawSyms)] : [])
                    };
                    codeSymbolEdges.push(edge);
                    inserted.push(edge);
                }
                return { rows: inserted, rowCount: inserted.length };
            }
        }

        // Symbol staleness count check in sync_to_pg.js
        if (norm.includes('COUNT(*)::INT AS CNT') && norm.includes('FROM CODE_SYMBOLS')) {
            const blobId = String(params[0] ?? '');
            const repoId = Number(params[1]);
            const filePath = String(params[2] ?? '');
            const activeModel = params[3] ? String(params[3]) : null;
            const matching = codeSymbols.filter(
                (s) => s.blob_id === blobId && Number(s.repository_id) === repoId && s.file_path === filePath
            );
            const staleCnt = matching.filter((s) => {
                if (!s.symbol_hash) return true;
                if (activeModel && (!s.embedding || s.embed_model !== activeModel)) return true;
                if (['function', 'class', 'method'].includes(s.symbol_type) && s.start_line === s.end_line) return true;
                return false;
            }).length;
            return { rows: [{ cnt: matching.length, stale_cnt: staleCnt }], rowCount: 1 };
        }

        // 2-Hop Graph Bridge query (WITH bridge_neighbors AS (...))
        if (norm.includes('WITH BRIDGE_NEIGHBORS')) {
            const repoIds = Array.isArray(params[0]) ? params[0].map(Number) : [];
            const seedPaths = Array.isArray(params[1]) ? params[1].map(normalizePosixRelPath) : [];
            const maxRows = Number(params[2]) || 60;

            const latestBlobs = getLatestDeduplicatedBlobs(null).filter(
                (b) => repoIds.includes(Number(b.repository_id)) && b.file_path
            );

            const candidates = [];
            const seenTriples = new Set();

            for (const edge of codeSymbolEdges) {
                const edgeRepoId = Number(edge.repository_id);
                if (!repoIds.includes(edgeRepoId)) continue;
                const cleanEdgeSrc = normalizePosixRelPath(edge.source_path);

                // Outbound: seed imports neighbor
                if (seedPaths.includes(cleanEdgeSrc)) {
                    for (const b of latestBlobs) {
                        if (Number(b.repository_id) !== edgeRepoId) continue;
                        const cleanCandPath = normalizePosixRelPath(b.file_path);
                        if (edgeResolvesToPath(cleanEdgeSrc, edge.target_path, cleanCandPath)) {
                            const triple = `${edgeRepoId}::${cleanCandPath}::${cleanEdgeSrc}::${edge.id}`;
                            if (!seenTriples.has(triple)) {
                                seenTriples.add(triple);
                                const repo = repositories.get(edgeRepoId);
                                candidates.push({
                                    id: b.id,
                                    repository_id: b.repository_id,
                                    project: repo?.name || 'krusch-git',
                                    summary: b.summary || (b.content ? b.content.toString('utf8').slice(0, 500) : ''),
                                    symbol_spine: b.symbol_spine ?? null,
                                    storage_mode: b.storage_mode,
                                    last_seen_at: b.last_seen_at,
                                    file_name: b.file_name || b.id,
                                    file_path: b.file_path,
                                    seed_path: cleanEdgeSrc,
                                    edge_source_path: edge.source_path,
                                    target_path: edge.target_path,
                                    relation: edge.relation,
                                    edge_symbols: edge.symbols || []
                                });
                            }
                        }
                    }
                }

                // Inbound: neighbor imports seed
                for (const seedPath of seedPaths) {
                    if (cleanEdgeSrc === seedPath) continue;
                    if (edgeResolvesToPath(cleanEdgeSrc, edge.target_path, seedPath)) {
                        const b = latestBlobs.find(
                            (cand) => Number(cand.repository_id) === edgeRepoId && normalizePosixRelPath(cand.file_path) === cleanEdgeSrc
                        );
                        if (b) {
                            const triple = `${edgeRepoId}::${cleanEdgeSrc}::${seedPath}::${edge.id}`;
                            if (!seenTriples.has(triple)) {
                                seenTriples.add(triple);
                                const repo = repositories.get(edgeRepoId);
                                candidates.push({
                                    id: b.id,
                                    repository_id: b.repository_id,
                                    project: repo?.name || 'krusch-git',
                                    summary: b.summary || (b.content ? b.content.toString('utf8').slice(0, 500) : ''),
                                    symbol_spine: b.symbol_spine ?? null,
                                    storage_mode: b.storage_mode,
                                    last_seen_at: b.last_seen_at,
                                    file_name: b.file_name || b.id,
                                    file_path: b.file_path,
                                    seed_path: seedPath,
                                    edge_source_path: edge.source_path,
                                    target_path: edge.target_path,
                                    relation: edge.relation,
                                    edge_symbols: edge.symbols || []
                                });
                            }
                        }
                    }
                }
            }

            const sliced = candidates.slice(0, maxRows);
            return { rows: sliced, rowCount: sliced.length };
        }

        // getBlob / read_blob query on blobs JOIN repositories
        if (norm.includes('FROM BLOBS B JOIN REPOSITORIES R') && norm.includes('WHERE B.ID = $1')) {
            const b = blobs.get(String(params[0]));
            if (!b) return { rows: [], rowCount: 0 };
            const repo = repositories.get(Number(b.repository_id));
            return { rows: [{ ...b, project: repo?.name || 'krusch-git' }], rowCount: 1 };
        }

        if (norm.includes('FROM BLOBS B JOIN REPOSITORIES R') && norm.includes('B.FILE_PATH = $1')) {
            const cleanPath = String(params[0] || '');
            const rawPath = String(params[1] || '');
            const repoId = params[2] !== undefined ? Number(params[2]) : null;
            const matches = Array.from(blobs.values())
                .filter(b => {
                    if (repoId !== null && Number(b.repository_id) !== repoId) return false;
                    return b.file_path === cleanPath || b.file_path === rawPath || b.file_name === cleanPath;
                })
                .sort((a, b) => new Date(b.last_seen_at || 0).getTime() - new Date(a.last_seen_at || 0).getTime());
            const rows = matches.map(b => ({
                ...b,
                project: repositories.get(Number(b.repository_id))?.name || 'krusch-git'
            }));
            return { rows: rows.slice(0, 1), rowCount: Math.min(1, rows.length) };
        }

        // searchBlobs (WITH dense_matches / WITH ann_candidates / WITH lexical_raw / lexical BM25)
        if (
            norm.includes('WITH DENSE_MATCHES') ||
            norm.includes('DENSE_MATCHES AS (') ||
            norm.includes('WITH ANN_CANDIDATES') ||
            norm.includes('ANN_CANDIDATES AS (') ||
            norm.includes('LEXICAL_RAW AS') ||
            (norm.includes('FROM BLOBS B') && norm.includes('JOIN REPOSITORIES R') && norm.includes('AS SIMILARITY'))
        ) {
            const isHybrid = norm.includes('DENSE_MATCHES AS (');
            const isDenseOnly = !isHybrid && norm.includes('ANN_CANDIDATES AS (');

            if (isHybrid) {
                const queryVec = parseVector(params[0]);
                const repoId = params[1] != null ? Number(params[1]) : null;
                const limitVal = Number(params[2]) || 5;
                const textQuery = String(params[3] || '');
                const activeModel = params[5] ? String(params[5]) : null;
                const candidatePoolSize = Math.max(60, limitVal * 10);

                const deduped = getLatestDeduplicatedBlobs(repoId);

                const denseScored = deduped
                    .filter((b) => b.embedding != null && (!activeModel || !b.embed_model || b.embed_model === activeModel))
                    .map((b) => ({ blob: b, dense_sim: cosineSimilarity(queryVec, b.embedding) }))
                    .sort((a, b) => b.dense_sim - a.dense_sim)
                    .slice(0, candidatePoolSize);

                const lexicalScored = deduped
                    .map((b) => ({ blob: b, lex: scoreBlobLexical(b, textQuery) }))
                    .filter((entry) => entry.lex.matched)
                    .sort((a, b) => b.lex.score - a.lex.score)
                    .slice(0, candidatePoolSize);

                const denseRankMap = new Map();
                denseScored.forEach((entry, idx) => denseRankMap.set(entry.blob.id, { rank: idx + 1, sim: entry.dense_sim, blob: entry.blob }));

                const lexRankMap = new Map();
                lexicalScored.forEach((entry, idx) => lexRankMap.set(entry.blob.id, { rank: idx + 1, score: entry.lex.score, blob: entry.blob }));

                const allIds = new Set([...denseRankMap.keys(), ...lexRankMap.keys()]);
                const fusedRows = [];
                for (const id of allIds) {
                    const d = denseRankMap.get(id);
                    const l = lexRankMap.get(id);
                    const b = (d?.blob || l?.blob);
                    const rrf = (d ? 1.0 / (60.0 + d.rank) : 0.0) + (l ? 1.0 / (60.0 + l.rank) : 0.0);
                    const decay = computeDecayFactor(b);
                    const repo = repositories.get(Number(b.repository_id));
                    fusedRows.push({
                        id: b.id,
                        repository_id: b.repository_id,
                        project: repo?.name || 'krusch-git',
                        summary: b.summary || (b.content ? b.content.toString('utf8').slice(0, 500) : ''),
                        symbol_spine: b.symbol_spine ?? null,
                        storage_mode: b.storage_mode,
                        last_seen_at: b.last_seen_at,
                        file_name: b.file_name || b.id,
                        file_path: b.file_path,
                        similarity: rrf * decay,
                        dense_sim: d ? d.sim : 0,
                        bm25_score: l ? l.score : 0
                    });
                }
                fusedRows.sort((a, b) => b.similarity - a.similarity);
                const top = fusedRows.slice(0, limitVal);
                return { rows: top, rowCount: top.length };
            }

            if (isDenseOnly) {
                const queryVec = parseVector(params[0]);
                const repoId = params[1] != null ? Number(params[1]) : null;
                const limitVal = Number(params[2]) || 5;
                const activeModel = params[3] ? String(params[3]) : null;
                const candidatePoolSize = Math.max(60, limitVal * 10);

                const deduped = getLatestDeduplicatedBlobs(repoId);
                const candidates = deduped
                    .filter((b) => b.embedding != null && (!activeModel || !b.embed_model || b.embed_model === activeModel))
                    .map((b) => {
                        const rawDenseSim = cosineSimilarity(queryVec, b.embedding);
                        const decay = computeDecayFactor(b);
                        const repo = repositories.get(Number(b.repository_id));
                        return {
                            id: b.id,
                            repository_id: b.repository_id,
                            project: repo?.name || 'krusch-git',
                            summary: b.summary || (b.content ? b.content.toString('utf8').slice(0, 500) : ''),
                            symbol_spine: b.symbol_spine ?? null,
                            storage_mode: b.storage_mode,
                            last_seen_at: b.last_seen_at,
                            file_name: b.file_name || b.id,
                            file_path: b.file_path,
                            raw_dense_sim: rawDenseSim,
                            decay_factor: decay,
                            similarity: rawDenseSim * decay
                        };
                    })
                    .sort((a, b) => b.raw_dense_sim - a.raw_dense_sim)
                    .slice(0, candidatePoolSize)
                    .sort((a, b) => b.similarity - a.similarity)
                    .slice(0, limitVal);

                return { rows: candidates, rowCount: candidates.length };
            }

            // Lexical BM25 branch
            const textQuery = String(params[0] || '');
            const hasExpandedParam = norm.includes('WEBSEARCH_TO_TSQUERY') || norm.includes('LEXICAL_RAW');
            const repoId = hasExpandedParam
                ? (params[3] != null ? Number(params[3]) : null)
                : (params.length >= 4 ? Number(params[2]) : null);
            const limitVal = hasExpandedParam
                ? (Number(params[4]) || 5)
                : (Number(params[params.length - 1]) || 5);

            const deduped = getLatestDeduplicatedBlobs(repoId);
            const lexRows = deduped
                .map((b) => ({ blob: b, lex: scoreBlobLexical(b, textQuery) }))
                .filter((entry) => entry.lex.matched)
                .map(({ blob: b, lex }) => {
                    const decay = computeDecayFactor(b);
                    const repo = repositories.get(Number(b.repository_id));
                    return {
                        id: b.id,
                        repository_id: b.repository_id,
                        project: repo?.name || 'krusch-git',
                        summary: b.summary || (b.content ? b.content.toString('utf8').slice(0, 500) : ''),
                        symbol_spine: b.symbol_spine ?? null,
                        storage_mode: b.storage_mode,
                        last_seen_at: b.last_seen_at,
                        file_name: b.file_name || b.id,
                        file_path: b.file_path,
                        similarity: lex.score * decay
                    };
                })
                .sort((a, b) => b.similarity - a.similarity)
                .slice(0, limitVal);

            return { rows: lexRows, rowCount: lexRows.length };
        }

        // getSymbolsForBlob
        if (norm.includes('FROM CODE_SYMBOLS S') && norm.includes('WHERE S.BLOB_ID = $1')) {
            const blobId = String(params[0]);
            const rows = codeSymbols
                .filter(s => s.blob_id === blobId)
                .sort((a, b) => a.start_line - b.start_line)
                .map(s => ({
                    ...s,
                    project: repositories.get(Number(s.repository_id))?.name || 'krusch-git'
                }));
            return { rows, rowCount: rows.length };
        }

        // searchSymbols semantic fallback (FROM code_symbols sym)
        if (norm.includes('FROM CODE_SYMBOLS SYM JOIN REPOSITORIES R')) {
            const qVec = parseVector(params[0]);
            const hasModelFilter = norm.includes('SYM.EMBED_MODEL = $2');
            const activeModel = hasModelFilter ? String(params[1] || '') : null;
            const rows = codeSymbols
                .filter((sym) => {
                    if (!sym.embedding) return false;
                    if (activeModel && sym.embed_model && sym.embed_model !== activeModel) return false;
                    return true;
                })
                .map((sym) => ({
                    ...sym,
                    project: repositories.get(Number(sym.repository_id))?.name || 'krusch-git',
                    similarity: cosineSimilarity(qVec, sym.embedding)
                }))
                .sort((a, b) => b.similarity - a.similarity);
            return { rows, rowCount: rows.length };
        }

        // searchSymbols lexical
        if (norm.includes('FROM CODE_SYMBOLS S JOIN REPOSITORIES R')) {
            const q = String(params[0] || '').toLowerCase();
            const repoId = sql.includes('s.repository_id = $3') ? Number(params[2]) : null;
            const rows = codeSymbols
                .filter(s => {
                    if (repoId && Number(s.repository_id) !== repoId) return false;
                    return s.symbol_name.toLowerCase().includes(q) || (s.content || '').toLowerCase().includes(q);
                })
                .map(s => ({
                    ...s,
                    project: repositories.get(Number(s.repository_id))?.name || 'krusch-git',
                    similarity: s.symbol_name.toLowerCase() === q ? 1.0 : 0.85
                }));
            return { rows, rowCount: rows.length };
        }

        // getSymbolGraph: outbound imports
        if (norm.includes('FROM CODE_SYMBOL_EDGES') && norm.includes('SOURCE_PATH = $2')) {
            const repoId = Number(params[0]);
            const p1 = String(params[1] || '');
            const p2 = String(params[2] || '');
            const rows = codeSymbolEdges.filter(e =>
                Number(e.repository_id) === repoId && (e.source_path === p1 || e.source_path === p2)
            );
            return { rows, rowCount: rows.length };
        }

        // getSymbolGraph: inbound dependents
        if (norm.includes('FROM CODE_SYMBOL_EDGES') && norm.includes('TARGET_PATH')) {
            const repoId = Number(params[0]);
            const cleanPath = String(params[1] || '');
            const baseName = cleanPath.split('/').pop().replace(/\.[^.]+$/, '');
            const dirName = cleanPath.includes('/') ? cleanPath.split('/').slice(0, -1).join('/') : '';
            const rows = codeSymbolEdges.filter(e => {
                if (Number(e.repository_id) !== repoId) return false;
                if (e.target_path === cleanPath || e.target_path.endsWith(`/${cleanPath}`)) return true;
                if (baseName !== 'index' && e.target_path.includes(baseName)) return true;
                if (dirName && e.source_path.startsWith(`${dirName}/`) && (e.target_path === './index.js' || e.target_path === './index')) {
                    return true;
                }
                return false;
            });
            return { rows, rowCount: rows.length };
        }

        // /api/graph & mcp dependency_graph symbol lookup: SELECT file_path, repository_id FROM code_symbols
        if (norm.includes('SELECT FILE_PATH, REPOSITORY_ID FROM CODE_SYMBOLS')) {
            const symName = String(params[0] || '').toLowerCase();
            const repoId = params[1] !== undefined ? Number(params[1]) : null;
            const found = codeSymbols
                .filter(s => s.symbol_name.toLowerCase() === symName && (repoId === null || Number(s.repository_id) === repoId))
                .sort((a, b) => b.id - a.id);
            return { rows: found.slice(0, 1), rowCount: Math.min(1, found.length) };
        }

        // getSymbolGraph: file's own symbols
        if (norm.includes('FROM CODE_SYMBOLS') && norm.includes('FILE_PATH = $2')) {
            const repoId = Number(params[0]);
            const p1 = String(params[1] || '');
            const p2 = String(params[2] || '');
            const rows = codeSymbols.filter(s =>
                Number(s.repository_id) === repoId && (s.file_path === p1 || s.file_path === p2)
            );
            return { rows, rowCount: rows.length };
        }

        return { rows: [], rowCount: 0 };
    }

    return {
        query,
        connect: async () => ({
            query,
            release: () => {}
        }),
        on: () => {},
        end: async () => {}
    };
}
