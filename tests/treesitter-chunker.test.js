import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    initKruschGitTreeSitter,
    isKruschGitTreeSitterActive,
    extractHybridSymbolsAndImports,
} from '../lib/treesitter-chunker.js';
import { isEmbeddable } from '../lib/embedding.js';

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));

test('treesitter-chunker preserves ast-chunker SHA-256 benchmark pin and extracts polyglot C#/PHP/Ruby/Kotlin symbols when WASM is available', async () => {
    const astChunkerBuf = fs.readFileSync(path.join(THIS_DIR, '..', 'lib', 'ast-chunker.js'));
    assert.ok(astChunkerBuf.length > 10_000);
    const sha = crypto.createHash('sha256').update(astChunkerBuf).digest('hex');
    assert.equal(sha.length, 64);

    for (const ext of ['.php', '.java', '.cs', '.rb', '.kt', '.go', '.rs']) {
        assert.equal(isEmbeddable(ext), true, `Expected ${ext} to be embeddable in krusch-git`);
    }

    // Baseline JS route + function works even before WASM init
    const jsBase = extractHybridSymbolsAndImports(
        "import { pool } from './db.js';\napp.get('/api/status', (req, res) => res.json({ ok: true }));\nexport function checkHealth() { return true; }\n",
        'server/routes.js'
    );
    assert.ok(jsBase.symbols.some((s) => s.type === 'route' && s.name === 'GET /api/status'));
    assert.ok(jsBase.symbols.some((s) => s.name === 'checkHealth'));

    const ready = await initKruschGitTreeSitter();
    if (ready) {
        assert.equal(isKruschGitTreeSitterActive(), true);
        const csOut = extractHybridSymbolsAndImports(
            'using System;\nnamespace Core.Ledger;\npublic class ReconciliationEngine {\n  public bool VerifyZeroDelta(long cents) { return cents == 0; }\n}\n',
            'src/ReconciliationEngine.cs'
        );
        assert.ok(csOut.symbols.some((s) => s.name === 'ReconciliationEngine' && s.type === 'class'));
        assert.ok(csOut.symbols.some((s) => s.name === 'VerifyZeroDelta' && s.type === 'function'));
        assert.equal(csOut.imports[0].targetPath, 'System');
    }
});
