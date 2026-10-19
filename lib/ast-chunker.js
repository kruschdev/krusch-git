/**
 * AST & Structural Code Symbol Chunker.
 * Extracts functions, classes, methods, routes, and dependency import edges
 * with line ranges and signatures across JavaScript, TypeScript, Python, Go, and Rust.
 * 
 * Zero external native dependencies for cross-node fleet portability.
 */

import path from 'path';
import crypto from 'crypto';

/**
 * Compute deterministic SHA-256 hash of normalized symbol or section text (KruschNexus page_hash parity).
 */
export function computeSymbolHash(text) {
    const normalized = String(text || '').replace(/\r\n/g, '\n').trim();
    return crypto.createHash('sha256').update(normalized, 'utf8').digest('hex');
}

/**
 * Extract compact deduplicated identifier tokens from a code block so PostgreSQL tsvector
 * can index all internal calls/variables without storing 3,000-char raw code snippets.
 */
export function extractCompactSymbolTokens(content, signature = '') {
    if (!content) return signature || '';
    const tokens = content.match(/[a-zA-Z_$][a-zA-Z0-9_$]{2,}/g) || [];
    const seen = new Set();
    const stopWords = new Set(['const', 'let', 'var', 'function', 'return', 'async', 'await', 'import', 'export', 'from', 'true', 'false', 'null', 'undefined', 'this', 'self', 'def', 'class', 'pub', 'struct', 'impl']);
    for (const tok of tokens) {
        if (!stopWords.has(tok)) {
            seen.add(tok);
            if (seen.size >= 60) break;
        }
    }
    const tokenLine = [...seen].join(' ');
    return signature ? `${signature}\n${tokenLine}` : tokenLine;
}

/**
 * Check if a '/' at index i in content is likely the start of a JS regex literal.
 */
function isRegexStart(content, i) {
    let j = i - 1;
    while (j >= 0 && (content[j] === ' ' || content[j] === '\t' || content[j] === '\r' || content[j] === '\n')) {
        j--;
    }
    if (j < 0) return true;
    const prev = content[j];
    if ('=(,[!&|?:;{}~^+-*%<>'.includes(prev)) return true;
    // Check preceding keyword like return, case, typeof
    const slice = content.slice(Math.max(0, j - 10), j + 1);
    return /\b(?:return|case|typeof|void|delete|in|instanceof|new)$/.test(slice);
}

/**
 * Find matching closing brace for a block starting at startIdx in content.
 */
function findMatchingBrace(content, startIdx, lang = 'c') {
    if (!content || startIdx < 0 || startIdx >= content.length) return -1;
    let braceIdx = startIdx;
    if (content[braceIdx] !== '{') {
        braceIdx = content.indexOf('{', startIdx);
        if (braceIdx === -1) return -1;
    }
    let depth = 0;
    let inString = null;
    let inComment = false;
    let inRegex = false;
    let inRegexCharClass = false;
    const allowHashComment = (lang === 'sh' || lang === 'shell' || lang === 'bash');
    
    for (let i = braceIdx; i < content.length; i++) {
        const char = content[i];
        const next = content[i + 1];

        // Handle regex literals
        if (inRegex) {
            if (char === '\\') {
                i++;
            } else if (char === '\n') {
                inRegex = false;
                inRegexCharClass = false;
            } else if (char === '[' && !inRegexCharClass) {
                inRegexCharClass = true;
            } else if (char === ']' && inRegexCharClass) {
                inRegexCharClass = false;
            } else if (char === '/' && !inRegexCharClass) {
                inRegex = false;
            }
            continue;
        }

        // Handle string literals
        if (inString) {
            if (char === '\\') {
                i++; // Skip escaped char
            } else if (char === inString) {
                inString = null;
            } else if (char === '\n' && (inString === '"' || inString === "'")) {
                inString = null;
            }
            continue;
        }

        // Handle comments
        if (inComment) {
            if (inComment === '//' && char === '\n') {
                inComment = false;
            } else if (inComment === '#' && char === '\n') {
                inComment = false;
            } else if (inComment === '/*' && char === '*' && next === '/') {
                inComment = false;
                i++;
            }
            continue;
        }

        if (char === '"' || char === "'" || char === '`') {
            inString = char;
            continue;
        }

        if (char === '/' && next === '/') {
            inComment = '//';
            i++;
            continue;
        }
        if (char === '/' && next === '*') {
            inComment = '/*';
            i++;
            continue;
        }
        if (!allowHashComment && char === '/' && isRegexStart(content, i)) {
            inRegex = true;
            inRegexCharClass = false;
            continue;
        }
        if (allowHashComment && char === '#') {
            inComment = '#';
            continue;
        }

        if (char === '{') {
            depth++;
        } else if (char === '}') {
            depth--;
            if (depth === 0) {
                return i;
            }
        }
    }
    return -1;
}

let lastIndexedText = null;
let lastIndexedOffsets = null;

/**
 * Calculate 1-indexed line number for a character index in text using cached binary search.
 */
function getLineNumber(text, index) {
    if (!text || index <= 0) return 1;
    if (text !== lastIndexedText) {
        lastIndexedText = text;
        const offsets = [0];
        for (let i = 0; i < text.length; i++) {
            if (text[i] === '\n') offsets.push(i + 1);
        }
        lastIndexedOffsets = offsets;
    }

    const offsets = lastIndexedOffsets;
    let low = 0;
    let high = offsets.length - 1;
    while (low <= high) {
        const mid = (low + high) >> 1;
        if (offsets[mid] <= index) {
            low = mid + 1;
        } else {
            high = mid - 1;
        }
    }
    return high + 1;
}

/**
 * Mask comments (and optionally string/regex literals) with spaces while preserving all newlines (\n)
 * so character indices and 1-indexed line numbers remain 100% identical to original content.
 */
function maskCode(content, { maskStrings = false, maskTemplateStrings = true, allowHashComment = false } = {}) {
    const chars = content.split('');
    let inString = null;
    let inComment = null;
    let inRegex = false;
    let inRegexCharClass = false;

    for (let i = 0; i < chars.length; i++) {
        const ch = chars[i];
        const next = chars[i + 1];

        if (inComment) {
            if ((inComment === '//' || inComment === '#') && ch === '\n') {
                inComment = null;
            } else if (inComment === '/*' && ch === '*' && next === '/') {
                chars[i] = ' ';
                chars[i + 1] = ' ';
                inComment = null;
                i++;
            } else if (ch !== '\n') {
                chars[i] = ' ';
            }
            continue;
        }

        if (inRegex) {
            if (ch === '\\') {
                if (maskStrings) {
                    if (chars[i] !== '\n') chars[i] = ' ';
                    if (i + 1 < chars.length && chars[i + 1] !== '\n') chars[i + 1] = ' ';
                }
                i++;
                continue;
            }
            if (ch === '\n') {
                inRegex = false;
                inRegexCharClass = false;
                continue;
            }
            if (ch === '[' && !inRegexCharClass) {
                inRegexCharClass = true;
            } else if (ch === ']' && inRegexCharClass) {
                inRegexCharClass = false;
            } else if (ch === '/' && !inRegexCharClass) {
                inRegex = false;
                continue;
            }
            if (maskStrings && ch !== '\n') {
                chars[i] = ' ';
            }
            continue;
        }

        if (inString) {
            const shouldMask = maskStrings || (maskTemplateStrings && inString === '`');
            if (ch === '\\') {
                if (shouldMask) {
                    if (chars[i] !== '\n') chars[i] = ' ';
                    if (i + 1 < chars.length && chars[i + 1] !== '\n') chars[i + 1] = ' ';
                }
                i++;
                continue;
            }
            if (ch === inString) {
                inString = null;
            } else if (ch === '\n' && (inString === '"' || inString === "'")) {
                inString = null;
            } else if (shouldMask && ch !== '\n') {
                chars[i] = ' ';
            }
            continue;
        }

        if (ch === '"' || ch === "'" || ch === '`') {
            inString = ch;
            continue;
        }

        if (ch === '/' && next === '/') {
            inComment = '//';
            chars[i] = ' ';
            chars[i + 1] = ' ';
            i++;
            continue;
        }
        if (ch === '/' && next === '*') {
            inComment = '/*';
            chars[i] = ' ';
            chars[i + 1] = ' ';
            i++;
            continue;
        }
        if (!allowHashComment && ch === '/' && isRegexStart(content, i)) {
            inRegex = true;
            inRegexCharClass = false;
            continue;
        }
        if (allowHashComment && ch === '#') {
            inComment = '#';
            chars[i] = ' ';
            continue;
        }
    }
    return chars.join('');
}

/**
 * Extract JavaScript and TypeScript symbols and imports.
 */
function parseJavaScriptOrTypeScript(content, filePath) {
    const symbols = [];
    const imports = [];
    const lines = content.split('\n');
    const noComments = maskCode(content, { maskStrings: false });
    const maskedDecls = maskCode(content, { maskStrings: true });

    // 1. Extract Imports (on comment-masked content, anchored to statement boundaries)
    // ES Module imports: import ... from '...' (supports type imports)
    const esImportRegex = /(?:^|\n)[ \t]*import\s+(?:type\s+)?(?:(?:\*\s+as\s+(\w+)|(\w+)|(?:\{([^}]+)\}))\s+from\s+)?['"]([^'"\n]+)['"]/g;
    let match;
    while ((match = esImportRegex.exec(noComments)) !== null) {
        const targetPath = match[4];
        const importedSymbols = [];
        if (match[1]) importedSymbols.push(match[1]); // import * as foo
        if (match[2] && match[2] !== 'type') importedSymbols.push(match[2]); // import defaultFoo
        if (match[3]) {
            match[3].split(',').forEach(s => {
                const cleaned = s.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0].trim();
                if (cleaned) importedSymbols.push(cleaned);
            });
        }
        imports.push({
            sourcePath: filePath,
            targetPath: targetPath,
            module: targetPath,
            relation: 'imports',
            symbols: importedSymbols
        });
    }

    // Dynamic imports: import('...')
    const dynamicImportRegex = /(?:await\s+)?import\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g;
    while ((match = dynamicImportRegex.exec(noComments)) !== null) {
        const targetPath = match[1];
        if (!imports.some(i => i.targetPath === targetPath)) {
            imports.push({
                sourcePath: filePath,
                targetPath,
                module: targetPath,
                relation: 'imports',
                symbols: []
            });
        }
    }

    // CommonJS requires: const ... = require('...')
    const cjsRequireRegex = /(?:const|let|var)\s+(?:(\w+)|\{([^}]+)\})\s*=\s*require\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g;
    while ((match = cjsRequireRegex.exec(noComments)) !== null) {
        const targetPath = match[3];
        const importedSymbols = [];
        if (match[1]) importedSymbols.push(match[1]);
        if (match[2]) {
            match[2].split(',').forEach(s => {
                const cleaned = s.trim().split(':')[0].trim();
                if (cleaned) importedSymbols.push(cleaned);
            });
        }
        imports.push({
            sourcePath: filePath,
            targetPath: targetPath,
            module: targetPath,
            relation: 'requires',
            symbols: importedSymbols
        });
    }

    // 2. Extract Functions and Classes (on comment+string-masked content so strings/comments never emit phantom symbols)
    // Functions: function foo(...), async function foo(...), export function foo(...)
    const functionRegex = /(?:export\s+)?(?:default\s+)?(?:async\s+)?function(?:\s*\*|\s+)?([a-zA-Z0-9_$]+)?(?:<[^>]+>)?\s*\(([^)]*)\)(?:\s*:[^{;\n]+)?\s*\{/g;
    while ((match = functionRegex.exec(maskedDecls)) !== null) {
        const name = match[1] || 'anonymous';
        const startIdx = match.index;
        const braceIdx = match.index + match[0].length - 1;
        const endIdx = findMatchingBrace(content, braceIdx);
        const startLine = getLineNumber(content, startIdx);
        const endLine = endIdx !== -1 ? getLineNumber(content, endIdx) : Math.min(startLine + 20, lines.length);
        const fullSignature = content.slice(startIdx, braceIdx).trim();
        const symbolContent = endIdx !== -1 ? content.slice(startIdx, endIdx + 1) : lines.slice(startLine - 1, endLine).join('\n');

        symbols.push({
            name,
            type: 'function',
            symbol_type: 'function',
            startLine,
            line_start: startLine,
            endLine,
            line_end: endLine,
            signature: fullSignature,
            content: symbolContent.slice(0, 3000)
        });
    }

    // Arrow functions / expressions assigned to const/let: const foo = async (...) => { ... }
    const arrowRegex = /(?:export\s+)?(?:const|let|var)\s+([a-zA-Z0-9_$]+)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[a-zA-Z0-9_$]+)(?:\s*:[^{;\n=]+)?\s*=>\s*\{/g;
    while ((match = arrowRegex.exec(maskedDecls)) !== null) {
        const name = match[1];
        const startIdx = match.index;
        const braceIdx = match.index + match[0].length - 1;
        const endIdx = findMatchingBrace(content, braceIdx);
        const startLine = getLineNumber(content, startIdx);
        const endLine = endIdx !== -1 ? getLineNumber(content, endIdx) : Math.min(startLine + 20, lines.length);
        const fullSignature = content.slice(startIdx, braceIdx).trim();
        const symbolContent = endIdx !== -1 ? content.slice(startIdx, endIdx + 1) : lines.slice(startLine - 1, endLine).join('\n');

        symbols.push({
            name,
            type: 'function',
            symbol_type: 'function',
            startLine,
            line_start: startLine,
            endLine,
            line_end: endLine,
            signature: fullSignature,
            content: symbolContent.slice(0, 3000)
        });
    }

    // Classes: class Foo extends Bar { ... }
    const classRegex = /(?:export\s+)?(?:default\s+)?class\s+([a-zA-Z0-9_$]+)(?:\s+extends\s+[a-zA-Z0-9_$.]+)?(?:\s+implements\s+[^{]+)?\s*\{/g;
    while ((match = classRegex.exec(maskedDecls)) !== null) {
        const className = match[1];
        const startIdx = match.index;
        const braceIdx = match.index + match[0].length - 1;
        const endIdx = findMatchingBrace(content, braceIdx);
        const startLine = getLineNumber(content, startIdx);
        const endLine = endIdx !== -1 ? getLineNumber(content, endIdx) : Math.min(startLine + 50, lines.length);
        const fullSignature = content.slice(startIdx, braceIdx).trim();
        const symbolContent = endIdx !== -1 ? content.slice(startIdx, endIdx + 1) : lines.slice(startLine - 1, endLine).join('\n');

        symbols.push({
            name: className,
            type: 'class',
            symbol_type: 'class',
            startLine,
            line_start: startLine,
            endLine,
            line_end: endLine,
            signature: fullSignature,
            content: symbolContent.slice(0, 4000)
        });

        // Parse Methods inside class
        if (endIdx !== -1) {
            const classBodyMasked = maskedDecls.slice(braceIdx + 1, endIdx);
            const methodRegex = /(?:static\s+)?(?:async\s+)?([a-zA-Z0-9_$]+)\s*\(([^)]*)\)(?:\s*:[^{;\n]+)?\s*\{/g;
            let mMatch;
            while ((mMatch = methodRegex.exec(classBodyMasked)) !== null) {
                const methodName = mMatch[1];
                if (['if', 'for', 'while', 'switch', 'catch', 'function', 'return'].includes(methodName)) continue;
                const mStartIdx = braceIdx + 1 + mMatch.index;
                const mBraceIdx = mStartIdx + mMatch[0].length - 1;
                const mEndIdx = findMatchingBrace(content, mBraceIdx);
                const mStartLine = getLineNumber(content, mStartIdx);
                const mEndLine = mEndIdx !== -1 ? getLineNumber(content, mEndIdx) : Math.min(mStartLine + 15, lines.length);
                const rawArgs = content.slice(mStartIdx, mBraceIdx).match(/\(([\s\S]*)\)/)?.[1] ?? mMatch[2];
                const mSignature = `${className}.${methodName}(${rawArgs.trim()})`;
                const mContent = mEndIdx !== -1 ? content.slice(mStartIdx, mEndIdx + 1) : lines.slice(mStartLine - 1, mEndLine).join('\n');

                symbols.push({
                    name: `${className}.${methodName}`,
                    methodName,
                    type: 'method',
                    symbol_type: 'method',
                    startLine: mStartLine,
                    line_start: mStartLine,
                    endLine: mEndLine,
                    line_end: mEndLine,
                    signature: mSignature,
                    content: mContent.slice(0, 3000)
                });

                if (mEndIdx !== -1) {
                    methodRegex.lastIndex = Math.max(methodRegex.lastIndex, (mEndIdx - (braceIdx + 1)) + 1);
                }
            }
        }
    }

    // Express / API routes: app.get('/path', ...), router.post('/path', ...)
    const routeRegex = /(?:app|router|server)\.(get|post|put|delete|patch|options)\s*\(\s*['"`]([^'"`\n]+)['"`]/g;
    while ((match = routeRegex.exec(noComments)) !== null) {
        const httpMethod = match[1].toUpperCase();
        const routePath = match[2];
        const startIdx = match.index;
        const startLine = getLineNumber(content, startIdx);
        const endLine = Math.min(startLine + 25, lines.length);
        const signature = `${httpMethod} ${routePath}`;

        symbols.push({
            name: `${httpMethod} ${routePath}`,
            type: 'route',
            symbol_type: 'route',
            startLine,
            line_start: startLine,
            endLine,
            line_end: endLine,
            signature,
            content: lines.slice(startLine - 1, endLine).join('\n').slice(0, 2000)
        });
    }

    // TypeScript interfaces: interface Foo { ... }
    const interfaceRegex = /(?:export\s+)?interface\s+([a-zA-Z0-9_$]+)(?:<[^>]+>)?(?:\s+extends\s+[^{]+)?\s*\{/g;
    while ((match = interfaceRegex.exec(maskedDecls)) !== null) {
        const name = match[1];
        const startIdx = match.index;
        const braceIdx = match.index + match[0].length - 1;
        const endIdx = findMatchingBrace(content, braceIdx);
        const startLine = getLineNumber(content, startIdx);
        const endLine = endIdx !== -1 ? getLineNumber(content, endIdx) : Math.min(startLine + 30, lines.length);
        const fullSignature = content.slice(startIdx, braceIdx).trim();
        const symbolContent = endIdx !== -1 ? content.slice(startIdx, endIdx + 1) : lines.slice(startLine - 1, endLine).join('\n');

        symbols.push({
            name,
            type: 'type',
            symbol_type: 'type',
            startLine,
            line_start: startLine,
            endLine,
            line_end: endLine,
            signature: fullSignature,
            content: symbolContent.slice(0, 3000)
        });
    }

    // TypeScript type aliases: type Foo = ...
    const typeAliasRegex = /(?:^|\n)[ \t]*(?:export\s+)?type\s+([a-zA-Z0-9_$]+)(?:<[^>]+>)?\s*=/g;
    while ((match = typeAliasRegex.exec(maskedDecls)) !== null) {
        const name = match[1];
        const startIdx = match.index + (match[0].startsWith('\n') ? 1 : 0);
        const startLine = getLineNumber(content, startIdx);
        const endIdx = maskedDecls.indexOf(';', startIdx);
        let endLine = startLine;
        if (endIdx !== -1 && endIdx - startIdx < 500) {
            endLine = getLineNumber(content, endIdx);
        } else {
            endLine = Math.min(startLine + 10, lines.length);
        }
        const fullSignature = content.slice(startIdx, match.index + match[0].length).trim();
        const symbolContent = lines.slice(startLine - 1, endLine).join('\n');

        symbols.push({
            name,
            type: 'type',
            symbol_type: 'type',
            startLine,
            line_start: startLine,
            endLine,
            line_end: endLine,
            signature: fullSignature,
            content: symbolContent.slice(0, 2000)
        });
    }

    // Enums: enum Foo { ... }, export enum Foo { ... }
    const enumRegex = /(?:export\s+)?(?:const\s+)?enum\s+([a-zA-Z0-9_$]+)\s*\{/g;
    while ((match = enumRegex.exec(maskedDecls)) !== null) {
        const name = match[1];
        const startIdx = match.index;
        const braceIdx = match.index + match[0].length - 1;
        const endIdx = findMatchingBrace(content, braceIdx);
        const startLine = getLineNumber(content, startIdx);
        const endLine = endIdx !== -1 ? getLineNumber(content, endIdx) : Math.min(startLine + 20, lines.length);
        const fullSignature = content.slice(startIdx, braceIdx).trim();
        const symbolContent = endIdx !== -1 ? content.slice(startIdx, endIdx + 1) : lines.slice(startLine - 1, endLine).join('\n');

        symbols.push({
            name,
            type: 'type',
            symbol_type: 'type',
            startLine,
            line_start: startLine,
            endLine,
            line_end: endLine,
            signature: fullSignature,
            content: symbolContent.slice(0, 2000)
        });
    }

    return { symbols, imports };
}

/**
 * Extract Python symbols and imports.
 */
function parsePython(content, filePath) {
    const symbols = [];
    const imports = [];
    const lines = content.split('\n');

    // 1. Python imports: import foo, from foo import bar (supports multiline parenthesized imports)
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line || line.startsWith('#')) continue;

        if (line.startsWith('import ')) {
            const modules = line.slice(7).split(',').map(m => m.trim().split(/\s+as\s+/)[0].trim());
            for (const mod of modules) {
                if (mod) {
                    imports.push({
                        sourcePath: filePath,
                        targetPath: mod,
                        module: mod,
                        relation: 'imports',
                        symbols: [mod]
                    });
                }
            }
        } else if (line.startsWith('from ')) {
            let fullImportLine = line;
            if (fullImportLine.includes('(') && !fullImportLine.includes(')')) {
                while (i + 1 < lines.length) {
                    i++;
                    const nextLine = lines[i].trim();
                    fullImportLine += ' ' + nextLine;
                    if (nextLine.includes(')')) break;
                }
            } else if (fullImportLine.endsWith('\\')) {
                while (i + 1 < lines.length) {
                    i++;
                    fullImportLine = fullImportLine.slice(0, -1).trim() + ' ' + lines[i].trim();
                    if (!lines[i].trim().endsWith('\\')) break;
                }
            }

            const fromMatch = fullImportLine.match(/^from\s+([a-zA-Z0-9_.]+)\s+import\s*(?:\(([\s\S]*?)\)|(.+))$/);
            if (fromMatch) {
                const targetPath = fromMatch[1];
                const rawSymbols = fromMatch[2] !== undefined ? fromMatch[2] : fromMatch[3];
                const cleanedSymbols = rawSymbols
                    .split('\n')
                    .map(l => l.replace(/#.*$/, ''))
                    .join(' ');
                const imported = cleanedSymbols
                    .split(',')
                    .map(s => s.trim().split(/\s+as\s+/)[0].trim())
                    .filter(s => s && s !== '(' && s !== ')');
                if (imported.length > 0) {
                    imports.push({
                        sourcePath: filePath,
                        targetPath,
                        module: targetPath,
                        relation: 'imports',
                        symbols: imported
                    });
                }
            }
        }
    }

    // 2. Python functions, classes, methods, and route decorators (FastAPI/Flask)
    let currentClass = null;
    let currentClassIndent = -1;
    let pendingDecorators = [];

    for (let i = 0; i < lines.length; i++) {
        const rawLine = lines[i];
        const trimmed = rawLine.trim();
        const indent = rawLine.search(/\S/);

        // Blank lines or comments don't reset pending decorators
        if (!trimmed || trimmed.startsWith('#')) continue;

        // Reset class context if indentation decreases
        if (currentClass && indent !== -1 && indent <= currentClassIndent) {
            currentClass = null;
            currentClassIndent = -1;
        }

        // Check for Route Decorators: @app.get(...), @router.post(...), @bp.route(...)
        const routeDecMatch = trimmed.match(/^@(?:[a-zA-Z0-9_]+)\.(get|post|put|delete|patch|options|route)\s*\(\s*['"]([^'"]+)['"](.*)?/i);
        if (routeDecMatch) {
            const decMethod = routeDecMatch[1].toLowerCase();
            const routePath = routeDecMatch[2];
            const extraArgs = routeDecMatch[3] || '';
            let httpMethods = [decMethod.toUpperCase()];

            if (decMethod === 'route') {
                const methodArgMatch = extraArgs.match(/methods\s*=\s*\[([^\]]+)\]/i);
                if (methodArgMatch) {
                    httpMethods = methodArgMatch[1]
                        .split(',')
                        .map(m => m.replace(/['"\s]/g, '').toUpperCase())
                        .filter(Boolean);
                } else {
                    httpMethods = ['GET'];
                }
            }

            pendingDecorators.push({
                httpMethods,
                routePath,
                startLine: i + 1,
                rawDecorator: trimmed
            });
            continue;
        }

        // Non-route decorators (e.g. @classmethod, @staticmethod, @limiter)
        if (trimmed.startsWith('@')) {
            continue;
        }

        // Class definition (single or multiline signature)
        const classStartMatch = trimmed.match(/^class\s+([a-zA-Z0-9_]+)/);
        if (classStartMatch && (trimmed.startsWith('class ') || trimmed.includes(':'))) {
            let sigLineEnd = i;
            let fullSignature = trimmed;
            if (!trimmed.endsWith(':')) {
                for (let k = i + 1; k < lines.length; k++) {
                    fullSignature += ' ' + lines[k].trim();
                    if (lines[k].trim().endsWith(':')) {
                        sigLineEnd = k;
                        break;
                    }
                }
            }
            pendingDecorators = [];
            const className = classStartMatch[1];
            currentClass = className;
            currentClassIndent = indent;
            const startLine = i + 1;

            let endLine = sigLineEnd + 1;
            for (let j = sigLineEnd + 1; j < lines.length; j++) {
                const nextRaw = lines[j];
                const nextIndent = nextRaw.search(/\S/);
                if (nextIndent !== -1 && nextIndent <= indent) {
                    break;
                }
                endLine = j + 1;
            }

            symbols.push({
                name: className,
                type: 'class',
                symbol_type: 'class',
                startLine,
                line_start: startLine,
                endLine,
                line_end: endLine,
                signature: fullSignature,
                content: lines.slice(startLine - 1, endLine).join('\n').slice(0, 4000)
            });
            i = sigLineEnd;
            continue;
        }

        // Function or method definition (single or multiline signature)
        const defStartMatch = trimmed.match(/^(?:async\s+)?def\s+([a-zA-Z0-9_]+)\s*\(/);
        if (defStartMatch) {
            const funcName = defStartMatch[1];
            let sigLineEnd = i;
            let fullSignature = trimmed;
            if (!trimmed.endsWith(':')) {
                for (let k = i + 1; k < lines.length; k++) {
                    fullSignature += ' ' + lines[k].trim();
                    if (lines[k].trim().endsWith(':')) {
                        sigLineEnd = k;
                        break;
                    }
                }
            }

            const isMethod = currentClass !== null && indent > currentClassIndent;
            const fullName = isMethod ? `${currentClass}.${funcName}` : funcName;
            const type = isMethod ? 'method' : 'function';
            const startLine = i + 1;

            let endLine = sigLineEnd + 1;
            for (let j = sigLineEnd + 1; j < lines.length; j++) {
                const nextRaw = lines[j];
                const nextIndent = nextRaw.search(/\S/);
                if (nextIndent !== -1 && nextIndent <= indent) {
                    break;
                }
                endLine = j + 1;
            }

            // If there were pending route decorators, create route symbols
            if (pendingDecorators.length > 0) {
                for (const dec of pendingDecorators) {
                    for (const httpMethod of dec.httpMethods) {
                        symbols.push({
                            name: `${httpMethod} ${dec.routePath}`,
                            type: 'route',
                            symbol_type: 'route',
                            startLine: dec.startLine,
                            line_start: dec.startLine,
                            endLine,
                            line_end: endLine,
                            signature: `${dec.rawDecorator} def ${funcName}`,
                            content: lines.slice(dec.startLine - 1, endLine).join('\n').slice(0, 3000)
                        });
                    }
                }
                pendingDecorators = [];
            }

            symbols.push({
                name: fullName,
                type,
                symbol_type: type,
                startLine,
                line_start: startLine,
                endLine,
                line_end: endLine,
                signature: fullSignature,
                content: lines.slice(startLine - 1, endLine).join('\n').slice(0, 3000)
            });

            i = sigLineEnd;
            continue;
        }

        // If not a decorator, class, or def, clear pending decorators
        pendingDecorators = [];
    }

    return { symbols, imports };
}

/**
 * Extract Go symbols and imports.
 */
function parseGo(content, filePath) {
    const symbols = [];
    const imports = [];
    const lines = content.split('\n');
    const noComments = maskCode(content, { maskStrings: false });
    const maskedDecls = maskCode(content, { maskStrings: true });

    // 1. Go imports
    // Single: import "fmt" or import p "path"
    const singleImportRegex = /(?:^|\n)[ \t]*import\s+(?:([a-zA-Z0-9_]+)\s+)?["']([^"'\n]+)["']/g;
    let match;
    while ((match = singleImportRegex.exec(noComments)) !== null) {
        const targetPath = match[2];
        const alias = match[1] || targetPath.split('/').pop();
        imports.push({
            sourcePath: filePath,
            targetPath,
            module: targetPath,
            relation: 'imports',
            symbols: [alias]
        });
    }

    // Multiline: import ( ... )
    const multiImportRegex = /(?:^|\n)[ \t]*import\s*\(([\s\S]*?)\)/g;
    while ((match = multiImportRegex.exec(noComments)) !== null) {
        const block = match[1];
        const lineRegex = /(?:([a-zA-Z0-9_.]+)\s+)?["']([^"'\n]+)["']/g;
        let lMatch;
        while ((lMatch = lineRegex.exec(block)) !== null) {
            const targetPath = lMatch[2];
            const alias = (lMatch[1] && lMatch[1] !== '_') ? lMatch[1] : targetPath.split('/').pop();
            imports.push({
                sourcePath: filePath,
                targetPath,
                module: targetPath,
                relation: 'imports',
                symbols: [alias]
            });
        }
    }

    // 2. Go Functions and Methods: func Foo(...) or func (r *Receiver) Foo(...)
    const funcRegex = /(?:^|\n)[ \t]*func\s+(?:\(([^)]+)\)\s+)?([a-zA-Z0-9_]+)\s*\([^;{}]*?\)[^{;]*\{/g;
    while ((match = funcRegex.exec(maskedDecls)) !== null) {
        const receiver = match[1];
        const funcName = match[2];
        const startIdx = match.index + (match[0].startsWith('\n') ? 1 : 0);
        const braceIdx = match.index + match[0].length - 1;
        const endIdx = findMatchingBrace(content, braceIdx, 'c');
        const startLine = getLineNumber(content, startIdx);
        const endLine = endIdx !== -1 ? getLineNumber(content, endIdx) : Math.min(startLine + 30, lines.length);

        let name = funcName;
        let type = 'function';
        if (receiver) {
            type = 'method';
            const recvTypeMatch = receiver.trim().match(/(?:\*\s*)?([a-zA-Z0-9_]+)$/);
            if (recvTypeMatch) {
                name = `${recvTypeMatch[1]}.${funcName}`;
            }
        }

        const fullSignature = content.slice(startIdx, braceIdx).trim();
        const symbolContent = endIdx !== -1 ? content.slice(startIdx, endIdx + 1) : lines.slice(startLine - 1, endLine).join('\n');

        symbols.push({
            name,
            type,
            symbol_type: type,
            startLine,
            line_start: startLine,
            endLine,
            line_end: endLine,
            signature: fullSignature,
            content: symbolContent.slice(0, 3000)
        });
    }

    // 3. Go Structs and Interfaces (Types)
    const typeRegex = /(?:^|\n)[ \t]*type\s+([a-zA-Z0-9_]+)\s+(?:struct|interface)\s*\{/g;
    while ((match = typeRegex.exec(maskedDecls)) !== null) {
        const typeName = match[1];
        const startIdx = match.index + (match[0].startsWith('\n') ? 1 : 0);
        const braceIdx = match.index + match[0].length - 1;
        const endIdx = findMatchingBrace(content, braceIdx, 'c');
        const startLine = getLineNumber(content, startIdx);
        const endLine = endIdx !== -1 ? getLineNumber(content, endIdx) : Math.min(startLine + 25, lines.length);
        const fullSignature = content.slice(startIdx, braceIdx).trim();
        const symbolContent = endIdx !== -1 ? content.slice(startIdx, endIdx + 1) : lines.slice(startLine - 1, endLine).join('\n');

        symbols.push({
            name: typeName,
            type: 'type',
            symbol_type: 'type',
            startLine,
            line_start: startLine,
            endLine,
            line_end: endLine,
            signature: fullSignature,
            content: symbolContent.slice(0, 3000)
        });
    }

    return { symbols, imports };
}

/**
 * Extract Rust symbols and imports.
 */
function parseRust(content, filePath) {
    const symbols = [];
    const imports = [];
    const lines = content.split('\n');
    const noComments = maskCode(content, { maskStrings: false });
    const maskedDecls = maskCode(content, { maskStrings: true });

    // 1. Rust imports: use foo::bar; or use foo::{bar, baz};
    const useRegex = /(?:^|\n)[ \t]*(?:pub\s+)?use\s+([^;]+);/g;
    let match;
    while ((match = useRegex.exec(noComments)) !== null) {
        const rawImport = match[1].trim();
        let targetPath = rawImport;
        const importedSymbols = [];
        const braceMatch = rawImport.match(/^(.+?)::\{([^}]+)\}$/);
        if (braceMatch) {
            targetPath = braceMatch[1];
            braceMatch[2].split(',').forEach(s => {
                const cleaned = s.trim();
                if (cleaned) importedSymbols.push(cleaned);
            });
        } else {
            const parts = rawImport.split('::');
            importedSymbols.push(parts[parts.length - 1]);
        }
        imports.push({
            sourcePath: filePath,
            targetPath,
            module: targetPath,
            relation: 'imports',
            symbols: importedSymbols
        });
    }

    // 2. Rust Functions: fn foo(...) { ... }
    const fnRegex = /(?:^|\n)[ \t]*(?:pub(?:\([^)]+\))?\s+)?(?:async\s+)?(?:unsafe\s+)?(?:extern(?:\s+"[^"]*")?\s+)?fn\s+([a-zA-Z0-9_]+)\s*(?:<[^>]+>)?\s*\([^;{}]*?\)[^{;]*\{/g;
    while ((match = fnRegex.exec(maskedDecls)) !== null) {
        const funcName = match[1];
        const startIdx = match.index + (match[0].startsWith('\n') ? 1 : 0);
        const braceIdx = match.index + match[0].length - 1;
        const endIdx = findMatchingBrace(content, braceIdx, 'c');
        const startLine = getLineNumber(content, startIdx);
        const endLine = endIdx !== -1 ? getLineNumber(content, endIdx) : Math.min(startLine + 30, lines.length);
        const fullSignature = content.slice(startIdx, braceIdx).trim();
        const symbolContent = endIdx !== -1 ? content.slice(startIdx, endIdx + 1) : lines.slice(startLine - 1, endLine).join('\n');

        symbols.push({
            name: funcName,
            type: 'function',
            symbol_type: 'function',
            startLine,
            line_start: startLine,
            endLine,
            line_end: endLine,
            signature: fullSignature,
            content: symbolContent.slice(0, 3000)
        });
    }

    // 3. Rust Structs, Enums, Traits (Types)
    const typeRegex = /(?:^|\n)[ \t]*(?:pub(?:\([^)]+\))?\s+)?(struct|enum|trait)\s+([a-zA-Z0-9_]+)(?:<[^>]+>)?(?:\s+where[^{]+)?\s*\{/g;
    while ((match = typeRegex.exec(maskedDecls)) !== null) {
        const typeName = match[2];
        const startIdx = match.index + (match[0].startsWith('\n') ? 1 : 0);
        const braceIdx = match.index + match[0].length - 1;
        const endIdx = findMatchingBrace(content, braceIdx, 'c');
        const startLine = getLineNumber(content, startIdx);
        const endLine = endIdx !== -1 ? getLineNumber(content, endIdx) : Math.min(startLine + 30, lines.length);
        const fullSignature = content.slice(startIdx, braceIdx).trim();
        const symbolContent = endIdx !== -1 ? content.slice(startIdx, endIdx + 1) : lines.slice(startLine - 1, endLine).join('\n');

        symbols.push({
            name: typeName,
            type: 'type',
            symbol_type: 'type',
            startLine,
            line_start: startLine,
            endLine,
            line_end: endLine,
            signature: fullSignature,
            content: symbolContent.slice(0, 3000)
        });
    }

    return { symbols, imports };
}

/**
 * Extract Shell symbols (functions).
 */
function parseShell(content, filePath) {
    const symbols = [];
    const imports = [];
    const lines = content.split('\n');
    const maskedDecls = maskCode(content, { maskStrings: true, allowHashComment: true });

    // Shell functions: function foo { or foo() { or function foo() {
    const fnRegex = /(?:^|\n)[ \t]*(?:function\s+)?([a-zA-Z0-9_-]+)\s*(?:\(\s*\))?\s*\{/g;
    let match;
    while ((match = fnRegex.exec(maskedDecls)) !== null) {
        const funcName = match[1];
        if (['if', 'then', 'else', 'elif', 'fi', 'case', 'esac', 'for', 'while', 'until', 'do', 'done'].includes(funcName)) continue;
        const startIdx = match.index + (match[0].startsWith('\n') ? 1 : 0);
        const braceIdx = match.index + match[0].length - 1;
        const endIdx = findMatchingBrace(content, braceIdx, 'sh');
        const startLine = getLineNumber(content, startIdx);
        const endLine = endIdx !== -1 ? getLineNumber(content, endIdx) : Math.min(startLine + 20, lines.length);
        const fullSignature = content.slice(startIdx, braceIdx).trim();
        const symbolContent = endIdx !== -1 ? content.slice(startIdx, endIdx + 1) : lines.slice(startLine - 1, endLine).join('\n');

        symbols.push({
            name: funcName,
            type: 'function',
            symbol_type: 'function',
            startLine,
            line_start: startLine,
            endLine,
            line_end: endLine,
            signature: fullSignature,
            content: symbolContent.slice(0, 2000)
        });
    }

    return { symbols, imports };
}

/**
 * Extract KruschNexus-style Markdown heading sections (StructuredLocator spine) and relative doc links.
 */
function parseMarkdown(content, filePath) {
    const symbols = [];
    const imports = [];
    const lines = content.split('\n');
    const headings = [];
    let inFence = false;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (/^```|^~~~/.test(line.trim())) {
            inFence = !inFence;
            continue;
        }
        if (inFence) continue;

        const m = line.match(/^(#{1,4})\s+(.+?)\s*$/);
        if (m) {
            const level = m[1].length;
            const rawTitle = m[2].replace(/[`*_~]/g, '').trim();
            if (rawTitle) {
                headings.push({
                    level,
                    title: rawTitle,
                    signature: `${m[1]} ${rawTitle}`,
                    startLine: i + 1
                });
            }
        }
    }

    for (let idx = 0; idx < headings.length; idx++) {
        const curr = headings[idx];
        let endLine = lines.length;
        for (let nextIdx = idx + 1; nextIdx < headings.length; nextIdx++) {
            if (headings[nextIdx].level <= curr.level) {
                endLine = headings[nextIdx].startLine - 1;
                break;
            }
        }
        const sectionText = lines.slice(curr.startLine - 1, endLine).join('\n');
        symbols.push({
            name: curr.title,
            type: 'section',
            symbol_type: 'section',
            startLine: curr.startLine,
            line_start: curr.startLine,
            endLine,
            line_end: endLine,
            signature: curr.signature,
            content: sectionText.slice(0, 1800),
            symbol_hash: computeSymbolHash(sectionText)
        });
    }

    // Extract relative file links [text](path/to/file.md) as 'references' edges
    const linkRegex = /\[([^\]]+)\]\(([^)]+)\)/g;
    let match;
    const seenTargets = new Set();
    while ((match = linkRegex.exec(content)) !== null) {
        const rawHref = match[2].trim().split('#')[0].trim();
        if (!rawHref || /^(https?:|mailto:|file:|javascript:)/i.test(rawHref)) continue;
        if (!seenTargets.has(rawHref)) {
            seenTargets.add(rawHref);
            imports.push({
                sourcePath: filePath,
                targetPath: rawHref,
                module: rawHref,
                relation: 'references',
                symbols: [match[1].trim().slice(0, 80)]
            });
        }
    }

    return { symbols, imports };
}

/**
 * Fallback scanner for generic files.
 */
function parseGeneric(content, filePath, ext) {
    const symbols = [];
    const imports = [];
    const lines = content.split('\n');

    for (let i = 0; i < lines.length; i++) {
        const trimmed = lines[i].trim();
        // Generic C-like function pattern
        const match = trimmed.match(/^(?:[a-zA-Z0-9_.*]+\s+)+([a-zA-Z0-9_]+)\s*\([^)]*\)\s*\{/);
        if (match) {
            symbols.push({
                name: match[1],
                type: 'function',
                symbol_type: 'function',
                startLine: i + 1,
                line_start: i + 1,
                endLine: Math.min(i + 30, lines.length),
                line_end: Math.min(i + 30, lines.length),
                signature: trimmed,
                content: lines.slice(i, Math.min(i + 30, lines.length)).join('\n')
            });
        }
    }

    return { symbols, imports };
}

/**
 * Main parser entry point.
 * @param {string} content - Raw source code.
 * @param {string} filePath - File path or relative filename.
 * @returns {{ symbols: Array, imports: Array }}
 */
export function extractSymbolsAndImports(content, filePath) {
    if (!content || typeof content !== 'string' || content.length < 10) {
        return { symbols: [], imports: [] };
    }

    // Protection against binary payloads or null-byte corrupted strings
    if (content.slice(0, 1024).includes('\0')) {
        return { symbols: [], imports: [] };
    }

    // Protection against massive files / minified bundles causing event loop starvation
    const MAX_PARSE_SIZE = 1_500_000; // 1.5MB
    const safeContent = content.length > MAX_PARSE_SIZE ? content.slice(0, MAX_PARSE_SIZE) : content;

    const ext = path.extname(filePath || '').toLowerCase();

    try {
        let parsed;
        if (['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs'].includes(ext)) {
            parsed = parseJavaScriptOrTypeScript(safeContent, filePath);
        } else if (['.py'].includes(ext)) {
            parsed = parsePython(safeContent, filePath);
        } else if (['.go'].includes(ext)) {
            parsed = parseGo(safeContent, filePath);
        } else if (['.rs'].includes(ext)) {
            parsed = parseRust(safeContent, filePath);
        } else if (['.sh', '.bash'].includes(ext)) {
            parsed = parseShell(safeContent, filePath);
        } else if (['.md', '.mdx'].includes(ext)) {
            parsed = parseMarkdown(safeContent, filePath);
        } else {
            parsed = parseGeneric(safeContent, filePath, ext);
        }

        for (const sym of parsed.symbols) {
            if (!sym.symbol_hash) {
                sym.symbol_hash = computeSymbolHash(sym.content || sym.signature || sym.name);
            }
        }
        return parsed;
    } catch (err) {
        console.warn(`[ast-chunker] Failed parsing symbols for ${filePath}: ${err.message}`);
        return { symbols: [], imports: [] };
    }
}
