import test from 'node:test';
import assert from 'node:assert';
import { extractSymbolsAndImports } from '../lib/ast-chunker.js';
import { 
    searchBlobs, 
    searchSymbols, 
    getSymbolsForBlob, 
    getSymbolGraph, 
    createRepository,
    getRepositories
} from '../server/git-engine.js';
import { query } from '../db/pool.js';

test('AST Chunker: extracts JavaScript and TypeScript symbols & imports', () => {
    const code = `
import { pool, query } from '../db/pool.js';
import express from 'express';
const path = require('path');

export async function searchBlobs(queryOrVector, limit = 5, repositoryId) {
    return [];
}

export class EngineService {
    constructor(name) {
        this.name = name;
    }

    async start() {
        console.log('started');
    }
}

const formatHelper = (str) => {
    return str.trim();
};

app.get('/api/health', (req, res) => res.json({ ok: true }));
`;

    const { symbols, imports } = extractSymbolsAndImports(code, 'src/engine.js');

    assert.ok(Array.isArray(symbols), 'Symbols should be an array');
    assert.ok(Array.isArray(imports), 'Imports should be an array');

    // Function check
    const fn = symbols.find(s => s.name === 'searchBlobs');
    assert.ok(fn, 'Should find searchBlobs function');
    assert.strictEqual(fn.type, 'function');
    assert.ok(fn.startLine > 0);
    assert.ok(fn.endLine >= fn.startLine);
    assert.ok(fn.signature.includes('searchBlobs'));

    // Class check
    const cls = symbols.find(s => s.name === 'EngineService');
    assert.ok(cls, 'Should find EngineService class');
    assert.strictEqual(cls.type, 'class');

    // Method check
    const method = symbols.find(s => s.name === 'EngineService.start');
    assert.ok(method, 'Should find EngineService.start method');
    assert.strictEqual(method.type, 'method');

    // Arrow function check
    const arrow = symbols.find(s => s.name === 'formatHelper');
    assert.ok(arrow, 'Should find formatHelper arrow function');
    assert.strictEqual(arrow.type, 'function');

    // Route check
    const route = symbols.find(s => s.type === 'route');
    assert.ok(route, 'Should find Express route');
    assert.ok(route.name.includes('/api/health'));

    // Imports check
    const poolImport = imports.find(i => i.targetPath === '../db/pool.js');
    assert.ok(poolImport, 'Should find pool.js import');
    assert.deepStrictEqual(poolImport.symbols.sort(), ['pool', 'query']);

    const cjsImport = imports.find(i => i.targetPath === 'path');
    assert.ok(cjsImport, 'Should find path require');
    assert.strictEqual(cjsImport.relation, 'requires');
});

test('AST Chunker: extracts Python classes, methods, functions & imports', () => {
    const pyCode = `
import os
import sys
from typing import List, Optional

class SearchPipeline:
    def __init__(self, model_name: str):
        self.model_name = model_name

    def run_query(self, query: str) -> List[str]:
        return []

def initialize_pipeline() -> SearchPipeline:
    return SearchPipeline("bge-large")
`;

    const { symbols, imports } = extractSymbolsAndImports(pyCode, 'pipeline.py');

    assert.ok(symbols.length >= 3, `Expected at least 3 symbols, got ${symbols.length}`);
    const cls = symbols.find(s => s.name === 'SearchPipeline');
    assert.ok(cls, 'Should find SearchPipeline class');

    const method = symbols.find(s => s.name === 'SearchPipeline.run_query');
    assert.ok(method, 'Should find SearchPipeline.run_query method');
    assert.strictEqual(method.type, 'method');

    const fn = symbols.find(s => s.name === 'initialize_pipeline');
    assert.ok(fn, 'Should find initialize_pipeline function');
    assert.strictEqual(fn.type, 'function');

    const osImport = imports.find(i => i.targetPath === 'os');
    assert.ok(osImport, 'Should find os import');

    const typingImport = imports.find(i => i.targetPath === 'typing');
    assert.ok(typingImport, 'Should find typing import');
    assert.ok(typingImport.symbols.includes('List'));
});

test('Database Schema & Search: hybrid RRF, keyword, and backward compatibility', async () => {
    // 1. Ensure test repository exists
    const testRepoName = 'test-pg-git-modernization-' + Date.now();
    const repo = await createRepository(testRepoName, 'Testing hybrid search and symbols');
    assert.ok(repo && repo.id, 'Created test repository');

    try {
        // 2. Insert test blob with content, summary, and fake embedding
        const testBlobId = 'testsha' + Math.random().toString(36).substring(2, 10).padEnd(33, '0');
        const fakeEmbedding = '[' + new Array(1024).fill(0.01).join(',') + ']';
        const testContent = Buffer.from('export async function authenticateUser(token) { return jwt.verify(token); }');

        await query(`
            INSERT INTO blobs (id, repository_id, content, size, file_name, file_path, summary, storage_mode, embedding)
            VALUES ($1, $2, $3, $4, $5, $6, $7, 'pointer', $8::vector)
        `, [testBlobId, repo.id, testContent, testContent.length, 'auth.js', 'src/auth.js', 'Handles JWT user authentication and verification', fakeEmbedding]);

        // 3. Test backward compatibility: searchBlobs with raw number vector array
        const vectorQuery = new Array(1024).fill(0.01);
        const legacyResults = await searchBlobs(vectorQuery, 5, repo.id);
        assert.ok(Array.isArray(legacyResults), 'Legacy search should return array');
        assert.ok(legacyResults.length > 0, 'Should find test blob via vector');
        assert.strictEqual(legacyResults[0].id, testBlobId);
        assert.ok(legacyResults[0].similarity > 0);

        // 4. Test Keyword BM25 search via searchBlobs string query
        const keywordResults = await searchBlobs('JWT authentication', 5, repo.id, { search_type: 'keyword' });
        assert.ok(Array.isArray(keywordResults), 'Keyword search should return array');
        assert.ok(keywordResults.length > 0, 'Should find test blob via BM25');
        assert.strictEqual(keywordResults[0].id, testBlobId);

        // 5. Test Hybrid RRF search via searchBlobs with text + vector
        const hybridResults = await searchBlobs('JWT authentication', 5, repo.id, {
            search_type: 'hybrid',
            vector: vectorQuery
        });
        assert.ok(Array.isArray(hybridResults), 'Hybrid search should return array');
        assert.ok(hybridResults.length > 0, 'Should find test blob via hybrid RRF');
        assert.strictEqual(hybridResults[0].id, testBlobId);

        // 6. Insert test symbol into code_symbols
        await query(`
            INSERT INTO code_symbols (blob_id, repository_id, file_path, symbol_name, symbol_type, start_line, end_line, signature, content)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        `, [
            testBlobId,
            repo.id,
            'src/auth.js',
            'authenticateUser',
            'function',
            1,
            3,
            'export async function authenticateUser(token)',
            'export async function authenticateUser(token) { return jwt.verify(token); }'
        ]);

        // 7. Test searchSymbols
        const symbols = await searchSymbols('authenticateUser', 5, repo.id);
        assert.ok(symbols.length > 0, 'Should find symbol authenticateUser');
        assert.strictEqual(symbols[0].symbol_name, 'authenticateUser');
        assert.strictEqual(symbols[0].start_line, 1);
        assert.strictEqual(symbols[0].end_line, 3);
        assert.ok(symbols[0].similarity > 0.8, 'Exact symbol match should have high similarity');

        // 8. Test getSymbolsForBlob
        const blobSymbols = await getSymbolsForBlob(testBlobId);
        assert.strictEqual(blobSymbols.length, 1);
        assert.strictEqual(blobSymbols[0].symbol_name, 'authenticateUser');

        // 9. Insert test edges into code_symbol_edges and test getSymbolGraph
        await query(`
            INSERT INTO code_symbol_edges (repository_id, source_blob_id, source_path, target_path, relation, symbols)
            VALUES ($1, $2, $3, $4, 'imports', $5)
        `, [repo.id, testBlobId, 'src/auth.js', 'jsonwebtoken', ['verify', 'sign']]);

        await query(`
            INSERT INTO code_symbol_edges (repository_id, source_blob_id, source_path, target_path, relation, symbols)
            VALUES ($1, $2, $3, $4, 'imports', $5)
        `, [repo.id, testBlobId, 'src/routes.js', 'src/auth.js', ['authenticateUser']]);

        const graph = await getSymbolGraph('src/auth.js', repo.id);
        assert.strictEqual(graph.filePath, 'src/auth.js');
        assert.strictEqual(graph.symbols.length, 1);
        assert.strictEqual(graph.imports.length, 1);
        assert.strictEqual(graph.imports[0].target_path, 'jsonwebtoken');
        assert.strictEqual(graph.dependents.length, 1);
        assert.strictEqual(graph.dependents[0].source_path, 'src/routes.js');

    } finally {
        // Cleanup test repository and cascaded records
        await query(`DELETE FROM repositories WHERE id = $1`, [repo.id]);
    }
});
