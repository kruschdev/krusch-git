/**
 * @module lib/treesitter-chunker
 * @description Sibling WebAssembly Tree-sitter CST chunker bridge for `krusch-git`.
 *
 * Preserves byte-for-byte SHA-256 benchmark immutability on `lib/ast-chunker.js`
 * (`benchmarks/g4-wave2`) while adding 10-language / 14-extension WASM CST extraction
 * (`.php`, `.java`, `.cs`, `.rb`, `.kt` + enriched `.js`/`.ts`/`.py`/`.go`/`.rs`)
 * via `@krusch/toolkit/treesitter` when available, gracefully falling back to
 * `extractSymbolsAndImports` from `lib/ast-chunker.js` (and retaining route/markdown extraction).
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { extractSymbolsAndImports } from './ast-chunker.js';

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(MODULE_DIR, '..');
const MONOREPO_LIB_TREESITTER = path.resolve(PROJECT_ROOT, '..', '..', 'lib', 'treesitter.js');
const MONOREPO_DEADBOLT_ROOT = path.resolve(PROJECT_ROOT, '..', 'deadbolt');

const POLYGLOT_ONLY_EXTS = new Set(['.php', '.java', '.cs', '.rb', '.kt']);

let tsBridgeMod = null;
let initAttempted = false;

/**
 * Resolve `@krusch/toolkit/treesitter` via installed package or monorepo `lib/treesitter.js`,
 * keeping standalone `krusch-git` npm/CI installs 100% self-contained (`INV-LEGO-28A`).
 */
async function loadTreeSitterModule() {
    if (tsBridgeMod) return tsBridgeMod;
    try {
        tsBridgeMod = await import('@krusch/toolkit/treesitter');
        return tsBridgeMod;
    } catch {
        // Fall through to monorepo sibling check
    }
    if (fs.existsSync(MONOREPO_LIB_TREESITTER)) {
        try {
            tsBridgeMod = await import(pathToFileURL(MONOREPO_LIB_TREESITTER).href);
            return tsBridgeMod;
        } catch {
            tsBridgeMod = null;
        }
    }
    return null;
}

/**
 * Best-effort async preload of WASM grammars once per sync/server process.
 *
 * @param {{ wasmDir?: string, searchRoots?: string[] }} [options={}]
 * @returns {Promise<boolean>}
 */
export async function initKruschGitTreeSitter(options = {}) {
    const mod = await loadTreeSitterModule();
    if (!mod || typeof mod.initTreeSitterRuntime !== 'function') {
        initAttempted = true;
        return false;
    }
    if (mod.isTreeSitterReady()) {
        initAttempted = true;
        return true;
    }
    const defaultRoots = [PROJECT_ROOT];
    if (fs.existsSync(MONOREPO_DEADBOLT_ROOT)) {
        defaultRoots.push(MONOREPO_DEADBOLT_ROOT);
    }
    const extraRoots = Array.isArray(options.searchRoots) ? options.searchRoots : [];
    const res = await mod.initTreeSitterRuntime({
        ...(options.wasmDir ? { wasmDir: options.wasmDir } : {}),
        searchRoots: [...extraRoots, ...defaultRoots],
    });
    initAttempted = true;
    return Boolean(res?.ok && mod.isTreeSitterReady());
}

/**
 * Return whether the WASM CST runtime is currently active.
 *
 * @returns {boolean}
 */
export function isKruschGitTreeSitterActive() {
    return Boolean(tsBridgeMod?.isTreeSitterReady?.());
}

/**
 * Hybrid symbol & import extractor combining `ast-chunker.js` (Markdown headings, Express/FastAPI
 * routes, shell functions) with 10-language WebAssembly Tree-sitter CST symbols & imports when loaded.
 *
 * @param {string} content
 * @param {string} filePath
 * @returns {{ symbols: Array<object>, imports: Array<object> }}
 */
export function extractHybridSymbolsAndImports(content, filePath) {
    const baseline = extractSymbolsAndImports(content, filePath);
    if (!tsBridgeMod?.isTreeSitterReady?.()) {
        return baseline;
    }

    const ext = path.extname(String(filePath || '')).toLowerCase();
    const tsExtracted = tsBridgeMod.extractTreeSitterSymbolsAndImports(content, filePath);
    if (!tsExtracted) {
        return baseline;
    }

    // For languages not natively handled by ast-chunker (.php, .java, .cs, .rb, .kt), serve WASM CST directly.
    if (POLYGLOT_ONLY_EXTS.has(ext)) {
        return {
            symbols: tsExtracted.symbols,
            imports: tsExtracted.imports,
        };
    }

    // For JS/TS/Py/Go/Rust, preserve baseline route/method formatting and merge any extra CST symbols/imports
    // that regex brace-matching missed (e.g. destructured/multiline declarations or dynamic imports).
    const mergedSymbols = [...baseline.symbols];
    const seenSymbolKeys = new Set(
        baseline.symbols.map((s) => `${s.name}:${s.startLine}`)
    );
    for (const sym of tsExtracted.symbols) {
        const bareKey = `${sym.name}:${sym.startLine}`;
        const hasSameLine = baseline.symbols.some(
            (b) => b.startLine === sym.startLine && (b.name === sym.name || b.name.endsWith(`.${sym.name}`))
        );
        if (!seenSymbolKeys.has(bareKey) && !hasSameLine) {
            seenSymbolKeys.add(bareKey);
            mergedSymbols.push(sym);
        }
    }

    const mergedImports = [...baseline.imports];
    const seenTargets = new Set(baseline.imports.map((i) => i.targetPath));
    for (const imp of tsExtracted.imports) {
        if (imp.targetPath && !seenTargets.has(imp.targetPath)) {
            seenTargets.add(imp.targetPath);
            mergedImports.push(imp);
        }
    }

    return {
        symbols: mergedSymbols,
        imports: mergedImports,
    };
}

export { initAttempted };
