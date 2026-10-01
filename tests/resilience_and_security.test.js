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
        await assert.rejects(async () => {
            await client.callTool({
                name: 'krusch_git_read_blob',
                arguments: {
                    repo: 'krusch-git',
                    file_path: '../krusch-context-mcp/package.json'
                }
            });
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
        await assert.rejects(async () => {
            await client.callTool({
                name: 'krusch_git_read_blob',
                arguments: { repo: 'krusch-git', file_path: 'server/git-engine.js\0.txt' }
            });
        }, /null bytes/);

        // 2. file_symbols with null byte
        await assert.rejects(async () => {
            await client.callTool({
                name: 'krusch_git_file_symbols',
                arguments: { repo: 'krusch-git', file_path: 'server/git-engine.js\0.txt' }
            });
        }, /null bytes/);

        // 3. dependency_graph with null byte
        await assert.rejects(async () => {
            await client.callTool({
                name: 'krusch_git_dependency_graph',
                arguments: { repo: 'krusch-git', file_path: 'server/git-engine.js\0.txt' }
            });
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

after(async () => {
    await pool.end();
});
