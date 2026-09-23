import test from 'node:test';
import assert from 'node:assert';
import { extractSymbolsAndImports } from '../lib/ast-chunker.js';
import { resolveBlobContent } from '../server/git-engine.js';

test('Core Math: Temporal Exponential Decay calculation', () => {
    // Decay formula: score = cosine * exp(-0.01 * age_days)
    const decayRate = 0.01;
    const calculateDecay = (score, ageDays) => score * Math.exp(-decayRate * ageDays);

    const baseScore = 0.95;
    
    // Day 0: no decay
    const day0 = calculateDecay(baseScore, 0);
    assert.strictEqual(day0, 0.95);

    // Day 30: ~26% decay (factor ~0.740818)
    const day30 = calculateDecay(baseScore, 30);
    const expected30 = 0.95 * Math.exp(-0.30);
    assert.ok(Math.abs(day30 - expected30) < 1e-6);
    assert.ok(day30 < baseScore);
    assert.ok(day30 > 0.70);

    // Day 100: ~63% decay (factor ~0.367879)
    const day100 = calculateDecay(baseScore, 100);
    const expected100 = 0.95 * Math.exp(-1.0);
    assert.ok(Math.abs(day100 - expected100) < 1e-6);
    assert.ok(day100 < day30);

    // Newer identical match always beats older match
    const freshIdentical = calculateDecay(0.80, 2);
    const staleIdentical = calculateDecay(0.80, 180);
    assert.ok(freshIdentical > staleIdentical);
});

test('Core Math: Reciprocal Rank Fusion (RRF) calculation', () => {
    // RRF(d) = 1 / (k + rank_dense) + 1 / (k + rank_bm25) where k = 60
    const k = 60;
    const rrf = (denseRank, bm25Rank) => {
        let score = 0;
        if (denseRank != null) score += 1 / (k + denseRank);
        if (bm25Rank != null) score += 1 / (k + bm25Rank);
        return score;
    };

    // Both rank 1 (top match in both dense and sparse)
    const topMatch = rrf(1, 1);
    assert.strictEqual(topMatch, 2 / 61);

    // Dense rank 1 only
    const denseOnly = rrf(1, null);
    assert.strictEqual(denseOnly, 1 / 61);

    // Fused match beats single-modality match
    assert.ok(topMatch > denseOnly);

    // Higher ranks produce higher scores
    assert.ok(rrf(1, 5) > rrf(5, 5));
});

test('Pointer Resolution: safely handles null, direct, and missing pointer blobs', async () => {
    // 1. Null blob returns null
    const nullResult = await resolveBlobContent(null);
    assert.strictEqual(nullResult, null);

    // 2. Direct storage returns content directly
    const directBlob = {
        id: 101,
        storage_mode: 'direct',
        content: Buffer.from('console.log("hello world");')
    };
    const directResult = await resolveBlobContent(directBlob);
    assert.strictEqual(directResult.toString(), 'console.log("hello world");');

    // 3. Pointer mode with missing file does not throw uncaught error, returns null safely
    const missingPointer = {
        id: 999,
        storage_mode: 'pointer',
        project: 'non-existent-project-xyz',
        file_path: 'does_not_exist.js'
    };
    const missingResult = await resolveBlobContent(missingPointer);
    assert.strictEqual(missingResult, null);
});

test('AST Chunker: robust extraction of symbols and import edges on JS fixture', () => {
    const jsFixture = `
import { Router } from 'express';
import { pool } from '../db/pool.js';

export class SymbolSearchEngine {
    constructor(options = {}) {
        this.options = options;
    }

    async findCallers(symbolName) {
        return pool.query('SELECT * FROM code_symbols WHERE name = $1', [symbolName]);
    }
}

export function createRouter() {
    const router = Router();
    router.get('/health', (req, res) => res.json({ status: 'ok' }));
    return router;
}
`;

    const { symbols, imports } = extractSymbolsAndImports(jsFixture, 'search-engine.js');

    // Should extract imports
    assert.ok(imports.length >= 2);
    const importModules = imports.map(i => i.targetPath);
    assert.ok(importModules.includes('express'));
    assert.ok(importModules.includes('../db/pool.js'));

    // Should extract class and methods
    const classSym = symbols.find(s => s.type === 'class' && s.name === 'SymbolSearchEngine');
    assert.ok(classSym, 'SymbolSearchEngine class must be extracted');
    assert.strictEqual(classSym.startLine, 5);

    const methodSym = symbols.find(s => s.type === 'method' && s.name === 'SymbolSearchEngine.findCallers');
    assert.ok(methodSym, 'findCallers method must be extracted');

    // Should extract exported function
    const funcSym = symbols.find(s => s.type === 'function' && s.name === 'createRouter');
    assert.ok(funcSym, 'createRouter function must be extracted');
});
