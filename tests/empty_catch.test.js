import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, '..');

function collectJsFiles(dir) {
    if (!fs.existsSync(dir)) return [];
    const results = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name.startsWith('.')) continue;
            results.push(...collectJsFiles(fullPath));
        } else if (entry.isFile() && /\.(js|mjs|cjs)$/.test(entry.name)) {
            results.push(fullPath);
        }
    }
    return results;
}

test('TEST-01 & BUG-01: no silent catch (_) {} blocks exist in scripts, server, lib, or db', () => {
    const sourceDirs = ['scripts', 'server', 'lib', 'db'];
    const emptyCatchRegex = /catch\s*\(\s*_\s*\)\s*\{\s*\}/g;
    const violations = [];

    for (const relDir of sourceDirs) {
        const files = collectJsFiles(path.join(ROOT_DIR, relDir));
        for (const file of files) {
            const content = fs.readFileSync(file, 'utf8');
            const matches = content.match(emptyCatchRegex);
            if (matches) {
                violations.push(path.relative(ROOT_DIR, file));
            }
        }
    }

    assert.deepEqual(
        violations,
        [],
        `Found silent catch (_) {} blocks in: ${violations.join(', ')}`
    );

    const syncAllSrc = fs.readFileSync(path.join(ROOT_DIR, 'scripts', 'sync_all_projects.js'), 'utf8');
    assert.ok(
        syncAllSrc.includes("console.error('[sync_all_projects] Failed to read HOMELAB_ROOT:', err);"),
        'sync_all_projects.js should log HOMELAB_ROOT read errors'
    );
});
