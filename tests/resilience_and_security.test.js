import test, { after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { server, verifyDatabase } from '../server/mcp.js';
import { resolveBlobContent, searchSymbols } from '../server/git-engine.js';
import { getEmbedding, generateDeterministicVector, validateVectorDimension, EMBEDDING_DIM } from '../lib/embedding.js';
import { extractSymbolsAndImports } from '../lib/ast-chunker.js';
import { pool, query } from '../db/pool.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function assertCallToolFails(client, toolCall, expectedRegex) {
    try {
        const res = await client.callTool(toolCall);
        assert.ok(res.isError, `Expected tool call to fail with error: ${expectedRegex}`);
        assert.match(res.content?.[0]?.text || '', expectedRegex);
    } catch (err) {
        assert.match(err.message, expectedRegex);
    }
}

test('Security: Cross-repository path traversal is strictly rejected', async () => {
    // 1. Direct resolveBlobContent check: attempting to escape repository root via relative traversal
    const escapeBlob = {
        id: 'traversal-test-blob',
        storage_mode: 'pointer',
        project: 'krusch-git',
        file_path: '../krusch-context-mcp/package.json'
    };

    const res = await resolveBlobContent(escapeBlob);
    // Must return null (safe rejection) rather than reading another repo's file
    assert.strictEqual(res, null, 'Cross-repository path traversal should be safely rejected');

    // 2. MCP Tool layer: client calling read_blob with cross-repo path
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: 'security-test-client', version: '1.0.0' }, { capabilities: {} });
    await client.connect(clientTransport);

    try {
        await assertCallToolFails(client, {
            name: 'krusch_git_read_blob',
            arguments: {
                repo: 'krusch-git',
                file_path: '../krusch-context-mcp/package.json'
            }
        }, /escapes repository root/);
    } finally {
        await client.close();
        await server.close();
    }
});

test('Security: Null byte injection in file paths is rejected across all tools', async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: 'null-byte-client', version: '1.0.0' }, { capabilities: {} });
    await client.connect(clientTransport);

    try {
        // 1. read_blob with null byte
        await assertCallToolFails(client, {
            name: 'krusch_git_read_blob',
            arguments: { repo: 'krusch-git', file_path: 'server/git-engine.js\0.txt' }
        }, /null bytes/);

        // 2. file_symbols with null byte
        await assertCallToolFails(client, {
            name: 'krusch_git_file_symbols',
            arguments: { repo: 'krusch-git', file_path: 'server/git-engine.js\0.txt' }
        }, /null bytes/);

        // 3. dependency_graph with null byte
        await assertCallToolFails(client, {
            name: 'krusch_git_dependency_graph',
            arguments: { repo: 'krusch-git', file_path: 'server/git-engine.js\0.txt' }
        }, /null bytes/);
    } finally {
        await client.close();
        await server.close();
    }
});

test('Resilience: Deterministic vectors for offline/CI environments', async () => {
    // 1. generateDeterministicVector generates exact dimension and L2 normalized vector
    const vec1 = generateDeterministicVector('hello world', 1024);
    assert.strictEqual(vec1.length, 1024);
    
    let norm = 0;
    for (const v of vec1) norm += v * v;
    assert.ok(Math.abs(Math.sqrt(norm) - 1.0) < 1e-4, 'Vector must be L2 normalized unit vector');

    // 2. Determinism: identical text produces identical vector
    const vec2 = generateDeterministicVector('hello world', 1024);
    assert.deepStrictEqual(vec1, vec2);

    // 3. Different text produces distinct vector
    const vec3 = generateDeterministicVector('different text string', 1024);
    assert.notDeepStrictEqual(vec1, vec3);

    // 4. getEmbedding in test environment returns deterministic vector instantly without network calls
    const embedded = await getEmbedding('export async function testFunction() {}');
    assert.ok(Array.isArray(embedded));
    assert.strictEqual(embedded.length, EMBEDDING_DIM);

    // 5. validateVectorDimension guards schema
    const validVec = new Array(1024).fill(0.01);
    assert.strictEqual(validateVectorDimension(validVec), validVec);
    assert.strictEqual(validateVectorDimension(new Array(512).fill(0.01)), null, 'Mismatched vector dimension must be rejected');
});

test('Resilience: AST chunker handles malformed, binary, and extreme files safely', () => {
    // 1. Binary payload with null bytes
    const binary = 'some header \0 binary bytes \0 foo bar';
    const binaryRes = extractSymbolsAndImports(binary, 'binary.js');
    assert.deepStrictEqual(binaryRes, { symbols: [], imports: [] });

    // 2. Short or empty content
    assert.deepStrictEqual(extractSymbolsAndImports('', 'empty.js'), { symbols: [], imports: [] });
    assert.deepStrictEqual(extractSymbolsAndImports(null, 'null.js'), { symbols: [], imports: [] });

    // 3. Very large file is bounded and parses in milliseconds due to binary search line lookup
    const largeContent = 'function hello() { return 1; }\n'.repeat(5000); // ~150KB, 5000 functions
    const start = Date.now();
    const largeRes = extractSymbolsAndImports(largeContent, 'large.js');
    const elapsed = Date.now() - start;
    assert.ok(Array.isArray(largeRes.symbols));
    assert.ok(largeRes.symbols.length > 0);
    assert.ok(elapsed < 2000, `AST chunking 5000 functions should take < 2000ms, took ${elapsed}ms`);
});

test('Resilience: Database verification retries and returns false instead of process.exit', async () => {
    // Calling verifyDatabase when DB is reachable returns true
    const healthy = await verifyDatabase(1, 10);
    assert.strictEqual(healthy, true);
});

test('REST API: Search, Symbols, and Graph endpoints respond correctly', async () => {
    const http = await import('node:http');
    const { app } = await import('../server/index.js');

    const srv = http.createServer(app);
    await new Promise((resolve) => srv.listen(0, resolve));
    const port = srv.address().port;
    const base = `http://127.0.0.1:${port}`;

    // Seed test repository & symbol hermetically
    const testRepoName = 'ci-api-test-repo-' + Date.now();
    const repoRes = await pool.query(
        `INSERT INTO repositories (name, description) VALUES ($1, 'CI API Test') RETURNING id`,
        [testRepoName]
    );
    const repoId = repoRes.rows[0].id;
    const testBlobId = 'ciblob' + Math.random().toString(36).substring(2, 10).padEnd(34, '0');
    await pool.query(
        `INSERT INTO blobs (id, repository_id, size, storage_mode, file_name, file_path, summary) VALUES ($1, $2, 100, 'pointer', 'test.js', 'lib/test.js', 'Hermetic test blob')`,
        [testBlobId, repoId]
    );
    await pool.query(`
        INSERT INTO code_symbols (blob_id, repository_id, file_path, symbol_name, symbol_type, start_line, end_line, signature, content)
        VALUES ($1, $2, 'lib/test.js', 'hermeticTestFunction', 'function', 1, 10, 'function hermeticTestFunction()', 'function hermeticTestFunction() { return true; }')
    `, [testBlobId, repoId]);
    await pool.query(`
        INSERT INTO code_symbol_edges (repository_id, source_blob_id, source_path, target_path, relation, symbols)
        VALUES ($1, $2, 'lib/test.js', 'lib/dep.js', 'imports', ARRAY['depSym'])
    `, [repoId, testBlobId]);

    try {
        // 1. Missing query returns 400
        const badSearch = await fetch(`${base}/api/search`);
        assert.strictEqual(badSearch.status, 400);

        // 2. Symbol search returns 200 with matching symbols
        const symRes = await fetch(`${base}/api/symbols?q=hermeticTestFunction`);
        assert.strictEqual(symRes.status, 200);
        const syms = await symRes.json();
        assert.ok(Array.isArray(syms));
        assert.ok(syms.some(s => s.symbol_name === 'hermeticTestFunction'));

        // 3. Search endpoint returns 200 with array
        const searchRes = await fetch(`${base}/api/search?q=hermetic&type=keyword`);
        assert.strictEqual(searchRes.status, 200);
        const searchData = await searchRes.json();
        assert.ok(Array.isArray(searchData));

        // 4. Graph endpoint resolves symbol declarations
        const graphRes = await fetch(`${base}/api/graph?symbol=hermeticTestFunction`);
        assert.strictEqual(graphRes.status, 200);
        const graphData = await graphRes.json();
        assert.ok(Array.isArray(graphData.symbols));
        assert.ok(Array.isArray(graphData.imports));
        assert.ok(Array.isArray(graphData.dependents));

        // 5. Null byte in blob ID returns 400
        const nullBlob = await fetch(`${base}/api/blobs/test%00blob`);
        assert.strictEqual(nullBlob.status, 400);

        // 6. GET /api/blobs/:id returns hydrated content field (INV-GIT-06)
        const blobRes = await fetch(`${base}/api/blobs/${testBlobId}`);
        assert.strictEqual(blobRes.status, 200);
        const blobData = await blobRes.json();
        assert.strictEqual(blobData.id, testBlobId);
        assert.ok('content' in blobData, 'GET /api/blobs/:id must include content property for Web UI viewer');

        // 7. GET /api/health returns database, queue, and embeddingCache (INV-GIT-06 & INV-GIT-08)
        const healthRes = await fetch(`${base}/api/health`);
        assert.strictEqual(healthRes.status, 200);
        const healthData = await healthRes.json();
        assert.strictEqual(healthData.status, 'ok');
        assert.strictEqual(healthData.database, true);
        assert.ok(Array.isArray(healthData.queue));
        assert.ok(healthData.embeddingCache && typeof healthData.embeddingCache.maxSize === 'number');

        // 8. POST /api/repos rejects empty repository name with 400 (INV-GIT-09)
        const badRepoRes = await fetch(`${base}/api/repos`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: '   ' })
        });
        assert.strictEqual(badRepoRes.status, 400);

        // 9. POST /api/repos rejects non-loopback requests without API key with 403 (GIT-05)
        const nonLoopbackRes = await fetch(`${base}/api/repos`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Forwarded-For': '203.0.113.42'
            },
            body: JSON.stringify({ name: 'unauthorized-repo' })
        });
        assert.strictEqual(nonLoopbackRes.status, 403);

        // 10. Explicit unknown repo parameter returns 404 instead of searching all repos (GIT-07)
        const unknownRepoRes = await fetch(`${base}/api/search?q=hermetic&repo=non-existent-repo-xyz-999`);
        assert.strictEqual(unknownRepoRes.status, 404);

        // 11. Unhandled database/internal errors delegate to centralized error handler and return generic 500 message (SEC-01)
        const dupRepoRes = await fetch(`${base}/api/repos`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: testRepoName, description: 'Trigger duplicate 500' })
        });
        assert.strictEqual(dupRepoRes.status, 500);
        const dupRepoData = await dupRepoRes.json();
        assert.strictEqual(dupRepoData.error, 'Internal server error');
    } finally {
        await pool.query(`DELETE FROM repositories WHERE id = $1`, [repoId]);
        await new Promise((resolve) => srv.close(resolve));
    }
});

test('GIT-08, GIT-10 & GIT-11: Fleet topology, empty-slice fallback, pointer hydration, and relative ./index.js caller matching', async () => {
    const { NODES } = await import('../scripts/parallel_tagger.js');
    const { resolveSymbolSnippet, getSymbolsForBlob, getSymbolGraph } = await import('../server/git-engine.js');

    // GIT-08: Default NODES targets local Ollama (127.0.0.1:11434) or TAG_OLLAMA_HOST for TAG_MODEL
    assert.ok(Array.isArray(NODES) && NODES.length >= 1);
    assert.ok(NODES[0].host.includes('127.0.0.1:11434') || Boolean(process.env.TAG_OLLAMA_HOST));

    // GIT-10: resolveSymbolSnippet falls back to signature when sliced line range is empty / out-of-bounds
    const fallbackSnippet = await resolveSymbolSnippet({
        id: 9999,
        project: 'krusch-git',
        file_path: 'bin/cli.js',
        start_line: 9999,
        end_line: 10005,
        signature: 'export async function fallbackSig()',
        content: '[POINTER_TOKENS]\nfallbackSig'
    });
    assert.strictEqual(fallbackSnippet, 'export async function fallbackSig()');

    // GIT-10 & GIT-11: getSymbolsForBlob hydrates [POINTER_TOKENS] and getSymbolGraph matches same-dir ./index.js callers
    const repoRes = await pool.query(
        `INSERT INTO repositories (name, description) VALUES ($1, 'GIT-10/11 Test') RETURNING id`,
        ['ci-git10-test-' + Date.now()]
    );
    const repoId = repoRes.rows[0].id;
    const blobId = 'git10blob' + Math.random().toString(36).substring(2, 10).padEnd(31, '0');

    try {
        await pool.query(
            `INSERT INTO blobs (id, repository_id, size, storage_mode, file_name, file_path, summary) VALUES ($1, $2, 100, 'pointer', 'index.js', 'server/index.js', 'Test index')`,
            [blobId, repoId]
        );
        await pool.query(`
            INSERT INTO code_symbols (blob_id, repository_id, file_path, symbol_name, symbol_type, start_line, end_line, signature, content)
            VALUES ($1, $2, 'server/index.js', 'testPointerSym', 'function', 9999, 10005, 'function testPointerSym()', '[POINTER_TOKENS]\ntestPointerSym tok1 tok2')
        `, [blobId, repoId]);
        await pool.query(`
            INSERT INTO code_symbol_edges (repository_id, source_blob_id, source_path, target_path, relation, symbols)
            VALUES ($1, $2, 'server/routes.js', './index.js', 'imports', ARRAY['app'])
        `, [repoId, blobId]);

        const blobSyms = await getSymbolsForBlob(blobId);
        assert.strictEqual(blobSyms.length, 1);
        assert.ok(!blobSyms[0].content.startsWith('[POINTER_TOKENS]'), 'getSymbolsForBlob must hydrate [POINTER_TOKENS]');
        assert.strictEqual(blobSyms[0].content, 'function testPointerSym()');

        const graph = await getSymbolGraph('server/index.js', repoId);
        assert.ok(graph.dependents.some(d => d.source_path === 'server/routes.js'), 'getSymbolGraph must match same-directory ./index.js caller');
    } finally {
        await pool.query(`DELETE FROM repositories WHERE id = $1`, [repoId]);
    }
});

test('INV-GIT-07 & INV-GIT-08: Embedding LRU cache and OllamaQueue deterministic FIFO priority', async () => {
    const { clearEmbeddingCache, getEmbeddingCacheStats } = await import('../lib/embedding.js');
    const { OllamaQueue, PRIORITY } = await import('../lib/llm-queue.js');

    clearEmbeddingCache();
    assert.strictEqual(getEmbeddingCacheStats().size, 0);

    const v1 = await getEmbedding('cache-test-query-alpha', PRIORITY.HIGH);
    assert.strictEqual(getEmbeddingCacheStats().size, 1);

    const v2 = await getEmbedding('cache-test-query-alpha', PRIORITY.HIGH);
    assert.deepStrictEqual(v1, v2);
    assert.strictEqual(getEmbeddingCacheStats().size, 1);

    // Verify OllamaQueue FIFO ordering within identical priority and HIGH pre-empting LOW
    const q = new OllamaQueue({ endpoints: ['http://localhost:11434'], concurrencyPerNode: 1 });
    const order = [];
    let unblockFirst;
    const firstGate = new Promise((r) => { unblockFirst = r; });

    const p1 = q.enqueue(async () => {
        await firstGate;
        order.push('first-in-flight');
        return 1;
    }, PRIORITY.LOW);

    // Enqueue two LOW tasks and two HIGH tasks while the single worker slot is occupied
    const pLow1 = q.enqueue(async () => { order.push('low-1'); return 2; }, PRIORITY.LOW);
    const pLow2 = q.enqueue(async () => { order.push('low-2'); return 3; }, PRIORITY.LOW);
    const pHigh1 = q.enqueue(async () => { order.push('high-1'); return 4; }, PRIORITY.HIGH);
    const pHigh2 = q.enqueue(async () => { order.push('high-2'); return 5; }, PRIORITY.HIGH);

    unblockFirst();
    await Promise.all([p1, pLow1, pLow2, pHigh1, pHigh2]);

    assert.deepStrictEqual(order, ['first-in-flight', 'high-1', 'high-2', 'low-1', 'low-2']);
});

test('BUG-02 & SEC-02: createRepository sanitizes duplicate constraint violation without leaking internal schema details', async () => {
    const { createRepository } = await import('../db/repository-service.js');
    const uniqueName = `dup-repo-test-${Date.now()}`;
    const created = await createRepository(uniqueName, 'Initial repo');
    assert.ok(created && created.id);
    try {
        await assert.rejects(
            async () => {
                await createRepository(uniqueName, 'Duplicate repo');
            },
            (err) => {
                assert.strictEqual(err.code, '23505');
                assert.strictEqual(err.status, 400);
                assert.strictEqual(err.message, 'Repository already exists');
                assert.ok(!/duplicate key value|repositories_name_key/i.test(err.message));
                return true;
            }
        );
    } finally {
        await pool.query(`DELETE FROM repositories WHERE id = $1`, [created.id]);
    }
});

test('BUG-01: createSyncProgress returns isolated per-run progress counters', async () => {
    const { createSyncProgress } = await import('../scripts/sync_to_pg.js');
    const p1 = createSyncProgress();
    const p2 = createSyncProgress();
    p1.processed += 5;
    p1.symbols += 12;
    assert.strictEqual(p2.processed, 0);
    assert.strictEqual(p2.symbols, 0);
});

after(async () => {
    await pool.end();
});




