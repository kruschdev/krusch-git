/**
 * Hermetic in-memory database fixture for krusch-git (BUG-01 & DX-01).
 * Used automatically when KRUSCH_EPHEMERAL=1 or when PostgreSQL is unreachable /
 * unauthenticated in test/CI environments.
 */

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
            storage_mode: 'pointer',
            embedding: new Array(1024).fill(0.01),
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
            symbol_hash: '30ea3e3ce9a5'
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
        if (Array.isArray(vecParam)) return vecParam.map(Number);
        if (typeof vecParam === 'string') {
            const cleaned = vecParam.trim().replace(/^\[|\]$/g, '');
            if (!cleaned) return [];
            return cleaned.split(',').map(Number);
        }
        return null;
    }

    function cosineSimilarity(a, b) {
        if (!a || !b || a.length === 0 || b.length === 0) return 0.5;
        const len = Math.min(a.length, b.length);
        let dot = 0;
        let normA = 0;
        let normB = 0;
        for (let i = 0; i < len; i++) {
            dot += a[i] * b[i];
            normA += a[i] * a[i];
            normB += b[i] * b[i];
        }
        if (normA === 0 || normB === 0) return 0.5;
        return dot / (Math.sqrt(normA) * Math.sqrt(normB));
    }

    async function query(sqlText, params = []) {
        const sql = String(sqlText || '').trim();
        const norm = sql.replace(/\s+/g, ' ').toUpperCase();

        if (norm === 'SELECT 1') {
            return { rows: [{ '?column?': 1 }], rowCount: 1 };
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
            if (norm.includes('WHERE ID = $1')) {
                const repo = repositories.get(Number(params[0]));
                return { rows: repo ? [repo] : [], rowCount: repo ? 1 : 0 };
            }
            const all = Array.from(repositories.values()).sort((a, b) => b.id - a.id);
            return { rows: all, rowCount: all.length };
        }

        // INSERT INTO blobs
        if (norm.startsWith('INSERT INTO BLOBS')) {
            const id = String(params[0]);
            const repository_id = Number(params[1]);
            let row;
            if (sql.includes('embedding')) {
                row = {
                    id,
                    repository_id,
                    content: params[2],
                    size: Number(params[3] || 0),
                    file_name: params[4] || id,
                    file_path: params[5] || '',
                    summary: params[6] || null,
                    storage_mode: 'pointer',
                    embedding: parseVector(params[7]),
                    last_seen_at: new Date(),
                    created_at: new Date()
                };
            } else if (params.length >= 6) {
                row = {
                    id,
                    repository_id,
                    content: null,
                    size: Number(params[2] || 0),
                    storage_mode: params[3] || 'pointer',
                    file_name: params[4] || id,
                    file_path: params[5] || '',
                    summary: params[6] || null,
                    embedding: new Array(1024).fill(0.01),
                    last_seen_at: new Date(),
                    created_at: new Date()
                };
            } else if (params.length === 2 && sql.includes('pointer')) {
                const isIndex = sql.includes('server/index.js');
                row = {
                    id,
                    repository_id,
                    content: null,
                    size: 100,
                    storage_mode: 'pointer',
                    file_name: isIndex ? 'index.js' : 'test.js',
                    file_path: isIndex ? 'server/index.js' : 'lib/test.js',
                    summary: isIndex ? 'Test index' : 'Hermetic test blob',
                    embedding: new Array(1024).fill(0.01),
                    last_seen_at: new Date(),
                    created_at: new Date()
                };
            } else {
                row = {
                    id,
                    repository_id,
                    content: params[2],
                    size: Number(params[3] || 0),
                    storage_mode: 'direct',
                    file_name: id,
                    file_path: '',
                    summary: null,
                    embedding: null,
                    last_seen_at: new Date(),
                    created_at: new Date()
                };
            }

            blobs.set(id, row);
            return { rows: [row], rowCount: 1 };
        }

        // INSERT INTO code_symbols
        if (norm.startsWith('INSERT INTO CODE_SYMBOLS')) {
            const sym = params.length >= 9
                ? {
                    id: nextSymbolId++,
                    blob_id: params[0],
                    repository_id: Number(params[1]),
                    file_path: params[2],
                    symbol_name: params[3],
                    symbol_type: params[4],
                    start_line: Number(params[5]),
                    end_line: Number(params[6]),
                    signature: params[7],
                    content: params[8],
                    symbol_hash: params[9] || null
                }
                : {
                    id: nextSymbolId++,
                    blob_id: params[0],
                    repository_id: Number(params[1]),
                    file_path: 'lib/test.js',
                    symbol_name: 'hermeticTestFunction',
                    symbol_type: 'function',
                    start_line: 1,
                    end_line: 10,
                    signature: 'function hermeticTestFunction()',
                    content: 'function hermeticTestFunction() { return true; }',
                    symbol_hash: null
                };
            if (params.length === 2 && sql.includes('server/index.js')) {
                sym.file_path = 'server/index.js';
                sym.symbol_name = 'testPointerSym';
                sym.start_line = 9999;
                sym.end_line = 10005;
                sym.signature = 'function testPointerSym()';
                sym.content = '[POINTER_TOKENS]\ntestPointerSym tok1 tok2';
            }
            codeSymbols.push(sym);
            return { rows: [sym], rowCount: 1 };
        }

        // INSERT INTO code_symbol_edges
        if (norm.startsWith('INSERT INTO CODE_SYMBOL_EDGES')) {
            let edge;
            if (params.length >= 5) {
                edge = {
                    id: nextEdgeId++,
                    repository_id: Number(params[0]),
                    source_blob_id: params[1],
                    source_path: params[2],
                    target_path: params[3],
                    relation: 'imports',
                    symbols: Array.isArray(params[4]) ? params[4] : [String(params[4])]
                };
            } else {
                const isRoutes = sql.includes('server/routes.js');
                edge = {
                    id: nextEdgeId++,
                    repository_id: Number(params[0]),
                    source_blob_id: params[1],
                    source_path: isRoutes ? 'server/routes.js' : 'lib/test.js',
                    target_path: isRoutes ? './index.js' : 'lib/dep.js',
                    relation: 'imports',
                    symbols: isRoutes ? ['app'] : ['depSym']
                };
            }
            codeSymbolEdges.push(edge);
            return { rows: [edge], rowCount: 1 };
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
            const matches = Array.from(blobs.values()).filter(b => {
                if (repoId !== null && Number(b.repository_id) !== repoId) return false;
                return b.file_path === cleanPath || b.file_path === rawPath || b.file_name === cleanPath;
            });
            const rows = matches.map(b => ({
                ...b,
                project: repositories.get(Number(b.repository_id))?.name || 'krusch-git'
            }));
            return { rows: rows.slice(0, 1), rowCount: Math.min(1, rows.length) };
        }

        // searchBlobs (WITH dense_matches / WITH ann_candidates / lexical BM25)
        if (norm.includes('WITH DENSE_MATCHES') || norm.includes('WITH ANN_CANDIDATES') || (norm.includes('FROM BLOBS B JOIN REPOSITORIES R') && norm.includes('SIMILARITY'))) {
            let repoId = null;
            let textQuery = '';
            let queryVec = null;

            if (norm.includes('WITH DENSE_MATCHES')) {
                queryVec = parseVector(params[0]);
                repoId = params[1] != null ? Number(params[1]) : null;
                textQuery = String(params[3] || '').toLowerCase();
            } else if (norm.includes('WITH ANN_CANDIDATES')) {
                queryVec = parseVector(params[0]);
                repoId = params[1] != null ? Number(params[1]) : null;
            } else {
                textQuery = String(params[0] || '').toLowerCase();
                if (params.length >= 4) repoId = Number(params[2]);
            }

            const results = [];
            for (const b of blobs.values()) {
                if (repoId !== null && !Number.isNaN(repoId) && Number(b.repository_id) !== repoId) continue;
                const hay = `${b.summary || ''} ${b.file_name || ''} ${b.file_path || ''} ${b.content ? b.content.toString('utf8') : ''}`.toLowerCase();
                const tokens = textQuery.split(/\s+/).filter(Boolean);
                const textMatches = tokens.length === 0 || tokens.some(t => hay.includes(t));
                if (!queryVec && !textMatches) continue;
                const sim = queryVec ? Math.max(0.5, cosineSimilarity(queryVec, b.embedding)) : 0.85;
                const repo = repositories.get(Number(b.repository_id));
                results.push({
                    id: b.id,
                    repository_id: b.repository_id,
                    project: repo?.name || 'krusch-git',
                    summary: b.summary || (b.content ? b.content.toString('utf8').slice(0, 500) : ''),
                    storage_mode: b.storage_mode,
                    last_seen_at: b.last_seen_at,
                    file_name: b.file_name || b.id,
                    file_path: b.file_path,
                    similarity: sim,
                    dense_sim: sim,
                    bm25_score: textMatches ? 0.5 : 0
                });
            }
            return { rows: results, rowCount: results.length };
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

        // searchSymbols
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

        // /api/graph symbol lookup: SELECT file_path, repository_id FROM code_symbols WHERE symbol_name = $1
        if (norm.includes('SELECT FILE_PATH, REPOSITORY_ID FROM CODE_SYMBOLS')) {
            const symName = String(params[0] || '');
            const repoId = params[1] !== undefined ? Number(params[1]) : null;
            const found = codeSymbols
                .filter(s => s.symbol_name === symName && (repoId === null || Number(s.repository_id) === repoId))
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
