import test, { after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import {
    EMBEDDING_DIM,
    canonicalizeEmbedModel,
    getActiveEmbedModel,
    validateVectorDimension,
    formatEmbeddingInput,
    calibrateQuerySimilarity,
    formatChunkHeader,
    getChunkedCentroidEmbedding
} from '../lib/embedding.js';
import {
    splitIdentifierSubtokens,
    extractQueryIdentifiers,
    buildExpandedEnglishQuery,
    findUnattestedIdentifiers,
    expandCodeGraphBridges
} from '../lib/graph-bridge.js';
import { buildSymbolSpine, insertBlob } from '../scripts/sync_to_pg.js';
import { buildBackfillQuery } from '../scripts/backfill_embeddings.js';
import { createMockDbPool } from '../db/db-mock.js';
import { createRepository, searchBlobs } from '../server/git-engine.js';
import { server } from '../server/mcp.js';
import { pool, query } from '../db/pool.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');

function makeDenseUnitVector(seedOffset = 0) {
    const raw = new Array(EMBEDDING_DIM);
    let normSq = 0;
    for (let i = 0; i < EMBEDDING_DIM; i++) {
        const val = Math.sin((i + 1) * 0.037 + seedOffset) + 0.25;
        raw[i] = val;
        normSq += val * val;
    }
    const norm = Math.sqrt(normSq);
    return raw.map((v) => v / norm);
}

test('INV-GIT-VEC-01: canonicalizeEmbedModel, finite dimension guard, nomic MRL prefixing, calibration, and chunk headers', async () => {
    // 1. Canonical model normalization
    assert.strictEqual(canonicalizeEmbedModel('snowflake-arctic-embed2:latest'), 'snowflake-arctic-embed2');
    assert.strictEqual(canonicalizeEmbedModel('  ollama/Snowflake-Arctic-Embed2:latest  '), 'snowflake-arctic-embed2');
    assert.strictEqual(canonicalizeEmbedModel('models/snowflake-arctic-embed2'), 'snowflake-arctic-embed2');
    assert.strictEqual(canonicalizeEmbedModel('qwen3-embedding:4b'), 'qwen3-embedding:4b');
    assert.strictEqual(canonicalizeEmbedModel(''), 'snowflake-arctic-embed2');

    // 2. Finite & dimension guard
    const valid = new Array(EMBEDDING_DIM).fill(0.02);
    assert.strictEqual(validateVectorDimension(valid, 'test'), valid);
    assert.strictEqual(validateVectorDimension(new Array(512).fill(0.02), 'test'), null);

    const withNaN = [...valid];
    withNaN[17] = Number.NaN;
    assert.strictEqual(validateVectorDimension(withNaN, 'test'), null);

    const withInf = [...valid];
    withInf[99] = Number.POSITIVE_INFINITY;
    assert.strictEqual(validateVectorDimension(withInf, 'test'), null);

    // 3. Nomic & Snowflake query prefix formatting
    assert.strictEqual(
        formatEmbeddingInput('hybrid search rrf', { model: 'nomic-embed-text:latest', mode: 'query' }),
        'search_query: hybrid search rrf'
    );
    assert.strictEqual(
        formatEmbeddingInput('search_query: already prefixed', { model: 'nomic-embed-text', mode: 'query' }),
        'search_query: already prefixed'
    );
    assert.strictEqual(
        formatEmbeddingInput('document body', { model: 'nomic-embed-text', mode: 'document' }),
        'document body'
    );
    assert.strictEqual(
        formatEmbeddingInput('episode rollups', { model: 'snowflake-arctic-embed2:latest', mode: 'query' }),
        'query: episode rollups'
    );

    // 4. Piecewise isotropic cosine calibration vs sparse synthetic mock pass-through
    const denseQueryVec = makeDenseUnitVector(1.1);
    const calLow = calibrateQuerySimilarity(0.10, { model: 'snowflake-arctic-embed2', queryVec: denseQueryVec });
    const calMid = calibrateQuerySimilarity(0.25, { model: 'snowflake-arctic-embed2', queryVec: denseQueryVec });
    const calHigh = calibrateQuerySimilarity(0.80, { model: 'qwen3-embedding:4b', queryVec: denseQueryVec });
    assert.ok(Math.abs(calLow - 0.30) < 1e-6);
    assert.ok(Math.abs(calMid - 0.52) < 1e-6);
    assert.ok(Math.abs(calHigh - 0.92) < 1e-6);

    const sparseMockVec = new Array(EMBEDDING_DIM).fill(0);
    sparseMockVec[0] = 1;
    assert.strictEqual(
        calibrateQuerySimilarity(0.25, { model: 'snowflake-arctic-embed2', queryVec: sparseMockVec }),
        0.25,
        'Sparse synthetic mock vectors must bypass isotropic calibration'
    );

    // 5. Context-header chunk grounding
    const header = formatChunkHeader('krusch-git', 'server/git-engine.js');
    assert.strictEqual(header, '[krusch-git :: server/git-engine.js]\n');
    assert.strictEqual(formatChunkHeader('', 'lib/embedding.js'), '[lib/embedding.js]\n');

    const baseVec = await getChunkedCentroidEmbedding('export function demo() { return 42; }');
    const groundedVec = await getChunkedCentroidEmbedding('export function demo() { return 42; }', undefined, {
        contextHeader: header
    });
    assert.strictEqual(groundedVec.length, EMBEDDING_DIM);
    assert.notDeepStrictEqual(groundedVec, baseVec, 'Context header must ground chunk embedding input');
});

test('INV-GIT-SCHEMA-02: migration 005 DDL, buildSymbolSpine, backfill query, and stale-model re-embedding', async () => {
    const migrationSql = await fs.readFile(
        path.join(PROJECT_ROOT, 'db', 'migrations', '005_context_v2_lessons.sql'),
        'utf-8'
    );
    const schemaSql = await fs.readFile(path.join(PROJECT_ROOT, 'db', 'schema.sql'), 'utf-8');

    for (const ddl of [migrationSql, schemaSql]) {
        assert.match(ddl, /embed_model\s+VARCHAR\(128\)/i);
        assert.match(ddl, /symbol_spine\s+TEXT/i);
        assert.match(ddl, /idx_blobs_repo_path_seen/i);
        assert.match(ddl, /idx_blobs_embed_model/i);
        assert.match(ddl, /to_tsvector\('english'/i);
    }

    const spine = buildSymbolSpine([
        { name: 'searchBlobs', type: 'function' },
        { name: 'searchBlobs', type: 'function' },
        { name: 'GET /api/episodes/rollup', type: 'route', signature: "app.get('/api/episodes/rollup')" }
    ]);
    assert.ok(spine.includes('searchBlobs'));
    assert.ok(spine.includes('episodes'));
    assert.ok(spine.includes('rollup'));

    const backfill = buildBackfillQuery({
        reembedStaleModel: true,
        projectFilter: 'krusch-context-mcp',
        activeModel: 'snowflake-arctic-embed2'
    });
    assert.match(backfill.queryText, /WITH latest_blobs AS/i);
    assert.match(backfill.queryText, /embed_model IS DISTINCT FROM \$2/i);
    assert.deepStrictEqual(backfill.params, ['krusch-context-mcp', 'snowflake-arctic-embed2']);

    // Verify insertBlob + populateSymbolsAndEdges against hermetic mock pool
    const mockPool = createMockDbPool();
    const seenHeaders = [];
    let embedCalls = 0;
    const fakeCentroid = async (_text, _prio, opts = {}) => {
        embedCalls++;
        seenHeaders.push(opts.contextHeader || '');
        return makeDenseUnitVector(embedCalls);
    };

    const srcBuf = Buffer.from(
        `import { helperFn } from './helper.js';\nexport function computeEpisodeRollup(turns) {\n  return helperFn(turns);\n}\n`
    );
    const fakeRoot = '/tmp/mock-krusch-repo';
    const fakeFile = '/tmp/mock-krusch-repo/src/episode-rollup.js';

    const prevSkip = process.env.SKIP_LLM_SUMMARY;
    const prevReembed = process.env.REEMBED_STALE_MODEL;
    process.env.SKIP_LLM_SUMMARY = 'true';
    try {
        const sha = await insertBlob(1, srcBuf, fakeFile, fakeRoot, undefined, 'krusch-context-mcp', {
            queryFn: mockPool.query,
            poolImpl: mockPool,
            embedCentroidFn: fakeCentroid,
            embedModel: 'bge-large'
        });
        assert.strictEqual(embedCalls, 1);
        assert.strictEqual(seenHeaders[0], '[krusch-context-mcp :: src/episode-rollup.js]\n');

        const stored1 = (await mockPool.query('SELECT id, embedding, embed_model, symbol_spine FROM blobs WHERE id = $1', [sha])).rows[0];
        assert.strictEqual(stored1.embed_model, 'bge-large');
        assert.ok(stored1.symbol_spine.includes('computeEpisodeRollup'));

        // Same model -> skipped without re-embedding
        await insertBlob(1, srcBuf, fakeFile, fakeRoot, undefined, 'krusch-context-mcp', {
            queryFn: mockPool.query,
            poolImpl: mockPool,
            embedCentroidFn: fakeCentroid,
            embedModel: 'bge-large'
        });
        assert.strictEqual(embedCalls, 1);

        // Stale model with REEMBED_STALE_MODEL=true -> re-embedded & upgraded to snowflake-arctic-embed2
        process.env.REEMBED_STALE_MODEL = 'true';
        await insertBlob(1, srcBuf, fakeFile, fakeRoot, undefined, 'krusch-context-mcp', {
            queryFn: mockPool.query,
            poolImpl: mockPool,
            embedCentroidFn: fakeCentroid,
            embedModel: 'snowflake-arctic-embed2'
        });
        assert.strictEqual(embedCalls, 2);
        const stored2 = (await mockPool.query('SELECT id, embedding, embed_model, symbol_spine FROM blobs WHERE id = $1', [sha])).rows[0];
        assert.strictEqual(stored2.embed_model, 'snowflake-arctic-embed2');
    } finally {
        if (prevSkip === undefined) delete process.env.SKIP_LLM_SUMMARY;
        else process.env.SKIP_LLM_SUMMARY = prevSkip;
        if (prevReembed === undefined) delete process.env.REEMBED_STALE_MODEL;
        else process.env.REEMBED_STALE_MODEL = prevReembed;
    }
});

test('INV-GIT-SEARCH-03: latest-blob deduplication, embed_model space isolation, morphological BM25, 2-hop graph bridge, and unattested identifiers', async () => {
    // Unit-check identifier helpers & zero-query gate when Hop-1 covers all tokens
    assert.ok(splitIdentifierSubtokens('searchBlobs').includes('blobs'));
    assert.match(buildExpandedEnglishQuery('searchBlobs hierarchical rollups'), /blobs/);
    const { rawIdentifiers } = extractQueryIdentifiers('Check `ghostSymbol_v2` and searchBlobs in src/auth.js');
    assert.ok(rawIdentifiers.includes('ghostSymbol_v2'));
    assert.ok(rawIdentifiers.includes('searchBlobs'));

    let bridgeQueries = 0;
    const coveredRows = [{
        id: 'b1',
        repository_id: 1,
        file_name: 'episode-rollup.js',
        file_path: 'src/episode-rollup.js',
        summary: 'Hierarchical episode rollup builder',
        symbol_spine: 'buildEpisodeRollup',
        similarity: 0.8
    }];
    const unchanged = await expandCodeGraphBridges(coveredRows, 'hierarchical episode rollups', {
        queryFn: async () => {
            bridgeQueries++;
            return { rows: [] };
        },
        repositoryId: 1,
        limit: 5
    });
    assert.strictEqual(bridgeQueries, 0, 'Must execute 0 SQL queries when Hop-1 already covers all query tokens');
    assert.strictEqual(unchanged.length, 1);

    // End-to-end integration against pool (works identically on db-mock and migrated live PostgreSQL)
    const activeModel = getActiveEmbedModel();
    const repoName = `test-context-v2-lessons-${Date.now()}`;
    const repo = await createRepository(repoName, 'Verify INV-GIT-SEARCH-03 invariants');

    const sharedVec = makeDenseUnitVector(2.5);
    const vecStr = `[${sharedVec.join(',')}]`;
    const orthVec = makeDenseUnitVector(9.9);
    const orthVecStr = `[${orthVec.join(',')}]`;

    const oldSha1 = `old1${Math.random().toString(36).slice(2, 10).padEnd(36, '0')}`;
    const oldSha2 = `old2${Math.random().toString(36).slice(2, 10).padEnd(36, '0')}`;
    const latestSha = `new3${Math.random().toString(36).slice(2, 10).padEnd(36, '0')}`;
    const staleModelSha = `stal${Math.random().toString(36).slice(2, 10).padEnd(36, '0')}`;
    const bridgeNeighborSha = `brdg${Math.random().toString(36).slice(2, 10).padEnd(36, '0')}`;
    const nullPathSha = `null${Math.random().toString(36).slice(2, 10).padEnd(36, '0')}`;

    try {
        // 1. Insert 2 historical shadow blobs + 1 newest blob for the SAME (repository_id, file_path)
        await query(
            `INSERT INTO blobs (id, repository_id, size, file_name, file_path, summary, symbol_spine, storage_mode, embedding, embed_model, last_seen_at, created_at)
             VALUES ($1, $2, 200, 'episode-rollup.js', 'src/episode-rollup.js', 'Legacy v1 episode rollup implementation', 'buildEpisodeRollup', 'pointer', $3::vector, $4, NOW() - INTERVAL '10 days', NOW() - INTERVAL '10 days')`,
            [oldSha1, repo.id, vecStr, activeModel]
        );
        await query(
            `INSERT INTO blobs (id, repository_id, size, file_name, file_path, summary, symbol_spine, storage_mode, embedding, embed_model, last_seen_at, created_at)
             VALUES ($1, $2, 220, 'episode-rollup.js', 'src/episode-rollup.js', 'Legacy v2 episode rollup implementation', 'buildEpisodeRollup', 'pointer', $3::vector, $4, NOW() - INTERVAL '5 days', NOW() - INTERVAL '5 days')`,
            [oldSha2, repo.id, vecStr, activeModel]
        );
        await query(
            `INSERT INTO blobs (id, repository_id, size, file_name, file_path, summary, symbol_spine, storage_mode, embedding, embed_model, last_seen_at, created_at)
             VALUES ($1, $2, 260, 'episode-rollup.js', 'src/episode-rollup.js', 'Hierarchical episode summary compaction engine', 'buildEpisodeRollup compactEpisodeWindow', 'pointer', $3::vector, $4, NOW(), NOW())`,
            [latestSha, repo.id, vecStr, activeModel]
        );

        // 2. Insert a blob with an incompatible legacy embed_model ('legacy-incompatible-v0')
        await query(
            `INSERT INTO blobs (id, repository_id, size, file_name, file_path, summary, symbol_spine, storage_mode, embedding, embed_model, last_seen_at, created_at)
             VALUES ($1, $2, 180, 'stale-vector.js', 'src/stale-vector.js', 'Completely unrelated file with incompatible vector geometry', 'staleFn', 'pointer', $3::vector, 'legacy-incompatible-v0', NOW(), NOW())`,
            [staleModelSha, repo.id, vecStr]
        );

        // 3. Insert a 1-hop neighbor blob connected via code_symbol_edges that owns an uncovered symbol `mergeSalienceCentroids`
        await query(
            `INSERT INTO blobs (id, repository_id, size, file_name, file_path, summary, symbol_spine, storage_mode, embedding, embed_model, last_seen_at, created_at)
             VALUES ($1, $2, 190, 'centroid-math.js', 'src/centroid-math.js', 'Salience centroid vector math utilities', 'mergeSalienceCentroids normalizeFloat32', 'pointer', $3::vector, $4, NOW(), NOW())`,
            [bridgeNeighborSha, repo.id, orthVecStr, activeModel]
        );
        await query(
            `INSERT INTO code_symbol_edges (repository_id, source_blob_id, source_path, target_path, relation, symbols)
             VALUES ($1, $2, 'src/episode-rollup.js', './centroid-math.js', 'imports', ARRAY['mergeSalienceCentroids'])`,
            [repo.id, latestSha]
        );

        // 4. Insert a null-path direct blob to verify file_path IS NULL rows remain searchable
        await query(
            `INSERT INTO blobs (id, repository_id, content, size, file_name, file_path, summary, storage_mode, embedding, embed_model)
             VALUES ($1, $2, $3, 32, 'raw-note', NULL, 'Standalone null path note', 'direct', $4::vector, $5)`,
            [nullPathSha, repo.id, Buffer.from('standalone note'), orthVecStr, activeModel]
        );

        // A. Pure semantic search: deduplicates shadow commits AND excludes incompatible embed_model
        const denseHits = await searchBlobs(sharedVec, 10, repo.id);
        const denseIds = denseHits.map((r) => r.id);
        assert.ok(denseIds.includes(latestSha), 'Newest blob for src/episode-rollup.js must be returned');
        assert.ok(!denseIds.includes(oldSha1), 'Historical shadow blob 1 must be deduplicated');
        assert.ok(!denseIds.includes(oldSha2), 'Historical shadow blob 2 must be deduplicated');
        assert.ok(!denseIds.includes(staleModelSha), 'Incompatible embed_model vector must be excluded from dense search');
        assert.ok(denseIds.includes(nullPathSha), 'Blobs with NULL file_path must still be retained');

        // B. Morphological plural + identifier BM25 search ('episode rollups' -> matches 'episode-rollup.js')
        const keywordHits = await searchBlobs('hierarchical episode rollups', 5, repo.id, { search_type: 'keyword' });
        assert.ok(keywordHits.length >= 1, 'Morphological plural query must match singular episode-rollup.js');
        assert.strictEqual(keywordHits[0].id, latestSha);
        assert.ok(!keywordHits.some((r) => r.id === oldSha1 || r.id === oldSha2));

        // C. Gated 2-hop graph bridge: Hop-1 finds episode-rollup.js via vector/keyword, Hop-2 bridges centroid-math.js for uncovered token
        // Pass keyword-only match on Hop-1 seed + uncovered neighbor token using include_bridges on hybrid search
        const bridgedHits = await searchBlobs(
            'hierarchical episode rollups with zzzUncoveredBridgeToken',
            5,
            repo.id,
            { search_type: 'hybrid', vector: sharedVec, include_bridges: true }
        );
        assert.ok(!bridgedHits.some((r) => r._isBridgeHop), 'Uncovered token not in neighbor must not bridge');

        // Query where Hop-1 hits episode-rollup.js (via vector, while neighbor vector is orthogonal) and 'mergeSalienceCentroids' is only in neighbor:
        // Note: if lexical_matches already finds centroid-math.js via symbol_spine, it's in Hop-1!
        // Test pure edge-symbol bridge where token is ONLY on edge.symbols ('aliasedBridgeExport'):
        await query(
            `INSERT INTO code_symbol_edges (repository_id, source_blob_id, source_path, target_path, relation, symbols)
             VALUES ($1, $2, 'src/episode-rollup.js', './centroid-math.js', 'imports', ARRAY['aliasedBridgeExport'])`,
            [repo.id, latestSha]
        );
        const hop2Hits = await searchBlobs(
            'episode rollups aliasedBridgeExport',
            5,
            repo.id,
            { search_type: 'keyword', include_bridges: true }
        );
        const bridgeRow = hop2Hits.find((r) => r.id === bridgeNeighborSha);
        assert.ok(bridgeRow, '2-hop graph bridge must pull 1-hop neighbor matching uncovered edge symbol');
        assert.strictEqual(bridgeRow._isBridgeHop, true);
        assert.strictEqual(bridgeRow._bridgeVia, 'src/episode-rollup.js');
        const topScore = Number(hop2Hits[0].similarity);
        assert.ok(bridgeRow.similarity <= Math.min(topScore * 0.84, 0.84) + 1e-9, 'Bridge score must obey strict 0.84 cap');

        // D. MCP krusch_git_semantic_search surfaces unattested code identifiers
        const unattestedDirect = findUnattestedIdentifiers(
            'episode rollups calling nonExistentPhantomHook',
            hop2Hits
        );
        assert.deepStrictEqual(unattestedDirect, ['nonExistentPhantomHook']);

        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        await server.connect(serverTransport);
        const mcpClient = new Client({ name: 'v2-lessons-test-client', version: '1.0.0' }, { capabilities: {} });
        await mcpClient.connect(clientTransport);
        try {
            const mcpRes = await mcpClient.callTool({
                name: 'krusch_git_semantic_search',
                arguments: {
                    repository_id: repo.id,
                    search_type: 'keyword',
                    query: 'episode rollups nonExistentPhantomHook'
                }
            });
            assert.ok(!mcpRes.isError);
            const textOut = mcpRes.content?.[0]?.text || '';
            assert.match(textOut, /episode-rollup\.js/);
            assert.match(textOut, /Unattested query identifiers not found in top matches: nonExistentPhantomHook/);
        } finally {
            await mcpClient.close();
            await server.close();
        }
    } finally {
        await query('DELETE FROM repositories WHERE id = $1', [repo.id]);
    }
});

test('Referee regressions: zero-similarity bridge cap, oversized hop1Rows tail replacement, and embedModel canonicalization', async () => {
    // 1. Zero-similarity Hop-1 row must keep bridge score capped at 0 (not coerced to 0.5 -> 0.42)
    const zeroHop1 = [
        {
            id: 'seed-zero',
            repository_id: 99,
            project: 'demo',
            file_name: 'entry.js',
            file_path: 'src/entry.js',
            summary: 'entry module',
            similarity: 0
        }
    ];
    let capturedNeighborLimit = null;
    const mockBridgeQuery = async (_sql, params) => {
        capturedNeighborLimit = params[2];
        return {
            rows: [
                {
                    id: 'nbr-1',
                    repository_id: 99,
                    project: 'demo',
                    file_name: 'helper.js',
                    file_path: 'src/helper.js',
                    summary: 'provides uncoveredTargetToken',
                    symbol_spine: 'uncoveredTargetToken',
                    seed_path: 'src/entry.js',
                    edge_source_path: 'src/entry.js',
                    target_path: './helper.js',
                    relation: 'imports',
                    edge_symbols: ['uncoveredTargetToken']
                }
            ]
        };
    };
    const zeroBridged = await expandCodeGraphBridges(zeroHop1, 'entry uncoveredTargetToken', {
        queryFn: mockBridgeQuery,
        repositoryId: 99,
        limit: 3
    });
    assert.ok(capturedNeighborLimit >= 250, `Expected neighborFetchLimit >= 250, got ${capturedNeighborLimit}`);
    const bridgedZeroRow = zeroBridged.find((r) => r.id === 'nbr-1');
    assert.ok(bridgedZeroRow);
    assert.strictEqual(bridgedZeroRow.similarity, 0, 'Zero-similarity seed must cap bridge similarity at 0');

    // 2. Oversized hop1Rows (> limit) still replaces weakest unprotected tail hit when bridge covers strictly more tokens
    const oversizedHop1 = [
        { id: 'h1', repository_id: 99, file_name: 'entry.js', file_path: 'src/entry.js', summary: 'entry', similarity: 0.9 },
        { id: 'h2', repository_id: 99, file_name: 'mid.js', file_path: 'src/mid.js', summary: 'entry', similarity: 0.7 },
        { id: 'h3', repository_id: 99, file_name: 'weak.js', file_path: 'src/weak.js', summary: 'unrelated', similarity: 0.2 },
        { id: 'h4', repository_id: 99, file_name: 'extra.js', file_path: 'src/extra.js', summary: 'unrelated', similarity: 0.1 }
    ];
    const replaced = await expandCodeGraphBridges(oversizedHop1, 'entry uncoveredTargetToken', {
        queryFn: mockBridgeQuery,
        repositoryId: 99,
        limit: 3
    });
    assert.strictEqual(replaced.length, 3);
    assert.ok(replaced.some((r) => r.id === 'nbr-1' && r._isBridgeHop === true));

    // 3. insertBlob canonicalizes ':latest' embedModel and forwards canonical model to embedCentroidFn & populateSymbolsAndEdges
    const mockPool = createMockDbPool();
    const repoRes = await mockPool.query(`INSERT INTO repositories (name) VALUES ('canon-test') RETURNING id`);
    const repoId = repoRes.rows[0].id;
    let forwardedCentroidOpts = null;
    let forwardedSymBatchOpts = null;
    const sha = await insertBlob(
        repoId,
        Buffer.from('export function testCanon() { return 42; }\n', 'utf-8'),
        '/workspace/canon-test/src/canon.js',
        '/workspace/canon-test',
        undefined,
        'canon-test',
        {
            queryFn: mockPool.query,
            poolImpl: mockPool,
            embedModel: 'ollama/snowflake-arctic-embed2:latest',
            embedSymbols: true,
            embedCentroidFn: async (_text, _prio, opts) => {
                forwardedCentroidOpts = opts;
                return new Array(EMBEDDING_DIM).fill(0.03125);
            },
            embedBatchFn: async (inputs, _prio, opts) => {
                forwardedSymBatchOpts = opts;
                return inputs.map(() => new Array(EMBEDDING_DIM).fill(0.03125));
            }
        }
    );
    assert.strictEqual(forwardedCentroidOpts?.model, 'snowflake-arctic-embed2');
    assert.strictEqual(forwardedSymBatchOpts?.model, 'snowflake-arctic-embed2');
    const savedBlob = await mockPool.query('SELECT embed_model FROM blobs WHERE id = $1', [sha]);
    assert.strictEqual(savedBlob.rows[0].embed_model, 'snowflake-arctic-embed2');
    const savedSyms = await mockPool.query('SELECT s.embed_model FROM code_symbols s WHERE s.blob_id = $1', [sha]);
    assert.strictEqual(savedSyms.rows[0].embed_model, 'snowflake-arctic-embed2');
});

after(async () => {
    await pool.end();
});
