/**
 * Zero-LLM, zero-embedding-RPC query identifier analysis, morphological English
 * tsquery expansion, unattested identifier detection, and gated 2-hop code graph
 * bridge expansion (`INV-GIT-SEARCH-03`).
 */

import path from 'node:path';

const QUERY_STOPWORDS = new Set([
    'the', 'and', 'for', 'with', 'from', 'how', 'what', 'where', 'when', 'why',
    'who', 'which', 'does', 'did', 'can', 'could', 'should', 'would', 'will',
    'into', 'onto', 'upon', 'about', 'that', 'this', 'these', 'those', 'there',
    'their', 'them', 'they', 'then', 'than', 'have', 'has', 'had', 'been',
    'were', 'was', 'are', 'is', 'be', 'do', 'in', 'on', 'at', 'to', 'of', 'by',
    'or', 'an', 'as', 'it', 'if', 'no', 'not', 'all', 'any', 'some', 'use',
    'used', 'using', 'get', 'set', 'show', 'find', 'list',
    'file', 'files', 'code', 'function', 'functions', 'method', 'methods',
    'class', 'classes'
]);

const ENGLISH_TS_OPERATORS_AND_FILLERS = new Set([
    'the', 'and', 'or', 'not', 'for', 'with', 'from', 'how', 'what', 'where',
    'when', 'why', 'who', 'which', 'does', 'did', 'into', 'about', 'that',
    'this', 'these', 'those', 'have', 'has', 'had', 'been', 'were', 'was',
    'are', 'is', 'be', 'do', 'in', 'on', 'at', 'to', 'of', 'by', 'an', 'as',
    'it', 'if'
]);

const PROSE_ABBREVIATIONS = new Set(['e.g', 'i.e', 'etc', 'vs', 'cf', 'u.s']);
const PROSE_SLASH_PAIRS = new Set([
    'and/or', 'read/write', 'true/false', 'yes/no', 'on/off', 'in/out', 'input/output'
]);
const GENERIC_BASENAMES = new Set([
    'index', 'main', 'app', 'utils', 'config', 'test', 'types', 'mod', 'lib'
]);
const KNOWN_CODE_PATH_PREFIXES = /^(?:\.{1,2}\/|src\/|lib\/|server\/|db\/|scripts\/|tests?\/|bin\/|client\/|docs\/|packages\/|app\/|components\/)/i;

/**
 * Split `camelCase`, `PascalCase`, `snake_case`, `kebab-case`, dotted names, and
 * path slashes into deduplicated lowercase alphanumeric sub-tokens (`>= 2` chars).
 *
 * Examples:
 * - `'searchBlobs'` -> `['searchblobs', 'search', 'blobs']`
 * - `'episode-rollup.js'` -> `['episode', 'rollup', 'js']`
 *
 * @param {string} token
 * @returns {string[]}
 */
export function splitIdentifierSubtokens(token) {
    if (!token || typeof token !== 'string') return [];
    const cleaned = token.trim().replace(/^[`"'([{<]+|[`"')\]}>.,;:?!]+$/g, '');
    if (!cleaned) return [];

    const seen = new Set();
    const out = [];
    const addSubtoken = (candidate) => {
        const lower = candidate.toLowerCase();
        if (lower.length >= 2 && /^[a-z0-9]+$/.test(lower) && !seen.has(lower)) {
            seen.add(lower);
            out.push(lower);
        }
    };

    const segments = cleaned.split(/[^a-zA-Z0-9]+/).filter(Boolean);
    for (const seg of segments) {
        if (seg.length < 2) continue;
        addSubtoken(seg);

        const camelSplit = seg
            .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
            .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
            .split(' ');
        if (camelSplit.length > 1) {
            for (const part of camelSplit) {
                if (part.length >= 2) {
                    addSubtoken(part);
                }
            }
        }
    }

    return out;
}

function cleanCandidateToken(raw) {
    return String(raw || '')
        .trim()
        .replace(/^[("'[{<]+/, '')
        .replace(/(?:\(\))?[)"'\]}>.,;:?!]*$/, '');
}

function isCamelCaseIdentifier(tok) {
    return /^[a-z_$][a-zA-Z0-9_$]*$/.test(tok) && /[a-z0-9][A-Z]/.test(tok);
}

function isPascalCaseIdentifier(tok) {
    if (!/^[A-Z][a-zA-Z0-9_$]*$/.test(tok)) return false;
    if (!/[a-z]/.test(tok)) return false;
    const upperCount = (tok.match(/[A-Z]/g) || []).length;
    return upperCount >= 2;
}

function isSnakeCaseIdentifier(tok) {
    return /^[a-zA-Z_$][a-zA-Z0-9_$]*_[a-zA-Z0-9_$]+$/.test(tok) && /[a-zA-Z]/.test(tok);
}

function isKebabCaseWithLetters(tok) {
    return /^[a-zA-Z][a-zA-Z0-9]*(?:-[a-zA-Z0-9]+)+$/.test(tok);
}

function isDottedOrFileIdentifier(tok) {
    if (!/^[a-zA-Z_$][a-zA-Z0-9_$-]*(?:\.[a-zA-Z0-9_$-]+)+$/.test(tok)) return false;
    const lower = tok.toLowerCase();
    if (PROSE_ABBREVIATIONS.has(lower)) return false;
    if (/^v\d+(?:\.\d+)+$/i.test(tok)) return false;
    return /[a-zA-Z]{2,}/.test(tok);
}

function isSlashPathIdentifier(tok) {
    if (!/^(?:\.{1,2}\/)?[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)+$/.test(tok)) return false;
    const lower = tok.toLowerCase();
    if (PROSE_SLASH_PAIRS.has(lower)) return false;
    if (tok.includes('.') || KNOWN_CODE_PATH_PREFIXES.test(tok) || tok.split('/').length >= 3) {
        return true;
    }
    return /[A-Z_-]/.test(tok);
}

/**
 * Extract code-shaped `rawIdentifiers` and stopword-filtered `distinctiveTokens`
 * from a search query (`INV-GIT-SEARCH-03`).
 *
 * @param {string} queryText
 * @returns {{ rawIdentifiers: string[], distinctiveTokens: string[] }}
 */
export function extractQueryIdentifiers(queryText) {
    if (!queryText || typeof queryText !== 'string') {
        return { rawIdentifiers: [], distinctiveTokens: [] };
    }

    const rawSeen = new Set();
    const rawIdentifiers = [];
    const addRaw = (ident) => {
        if (!ident || ident.length < 2) return;
        const key = ident.toLowerCase();
        if (!rawSeen.has(key)) {
            rawSeen.add(key);
            rawIdentifiers.push(ident);
        }
    };

    // 1. Extract backticked code spans first (`foo`, `pool.query`, `lib/embedding.js`)
    const backtickRegex = /`([^`\n]+)`/g;
    let btMatch;
    while ((btMatch = backtickRegex.exec(queryText)) !== null) {
        const inner = cleanCandidateToken(btMatch[1]);
        if (inner && !/\s/.test(inner) && /[a-zA-Z]/.test(inner) && inner.length >= 2) {
            addRaw(inner);
        }
    }

    // 2. Inspect whitespace-delimited tokens for code-shaped identifiers & distinctive subtokens
    const tokenSeen = new Set();
    const distinctiveTokens = [];
    const whitespaceTokens = queryText.replace(/`/g, ' ').split(/\s+/).filter(Boolean);

    for (const rawTok of whitespaceTokens) {
        const cleaned = cleanCandidateToken(rawTok);
        if (!cleaned) continue;

        if (
            isCamelCaseIdentifier(cleaned) ||
            isPascalCaseIdentifier(cleaned) ||
            isSnakeCaseIdentifier(cleaned) ||
            isKebabCaseWithLetters(cleaned) ||
            isDottedOrFileIdentifier(cleaned) ||
            isSlashPathIdentifier(cleaned)
        ) {
            addRaw(cleaned);
        }

        const subtokens = splitIdentifierSubtokens(cleaned);
        for (const sub of subtokens) {
            if (!QUERY_STOPWORDS.has(sub) && !tokenSeen.has(sub)) {
                tokenSeen.add(sub);
                distinctiveTokens.push(sub);
            }
        }
    }

    return { rawIdentifiers, distinctiveTokens };
}

/**
 * Convert `queryText` into camelCase/delimiter-split words suitable for PostgreSQL
 * `websearch_to_tsquery('english', ...)` OR-joined (`word1 OR word2 OR ...`, capped at 12 terms,
 * sanitized against special tsquery punctuation) so morphological plurals (`rollups` -> `rollup`)
 * and `camelCase` queries match `blobs.tsv` cleanly.
 *
 * @param {string} queryText
 * @returns {string}
 */
export function buildExpandedEnglishQuery(queryText) {
    if (!queryText || typeof queryText !== 'string') return '';

    const primaryTerms = [];
    const fallbackTerms = [];
    const seenPrimary = new Set();
    const seenFallback = new Set();

    const rawParts = queryText
        .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .split(/[^a-zA-Z0-9]+/)
        .filter(Boolean);

    for (const part of rawParts) {
        const lower = part.toLowerCase();
        if (lower.length < 2 || !/^[a-z0-9]+$/.test(lower)) continue;
        if (ENGLISH_TS_OPERATORS_AND_FILLERS.has(lower)) continue;

        if (!seenFallback.has(lower)) {
            seenFallback.add(lower);
            fallbackTerms.push(lower);
        }
        if (!QUERY_STOPWORDS.has(lower) && !seenPrimary.has(lower)) {
            seenPrimary.add(lower);
            primaryTerms.push(lower);
        }
    }

    const chosen = primaryTerms.length > 0 ? primaryTerms : fallbackTerms;
    if (chosen.length === 0) return '';
    return chosen.slice(0, 12).join(' OR ');
}

/**
 * Inspect code-shaped identifiers in `queryText` (`camelCase`, `PascalCase`, `snake_case`,
 * backticked `` `ident` ``, slash paths, or file/dotted tokens like `foo.js` / `pool.query`;
 * ignoring plain single lowercase English words) and return those whose lowercase form does
 * NOT appear anywhere in `blobRows` or `symbolRows` (`INV-GIT-SEARCH-03`).
 *
 * @param {string} queryText
 * @param {Array<object>} [blobRows=[]]
 * @param {Array<object>} [symbolRows=[]]
 * @returns {string[]}
 */
export function findUnattestedIdentifiers(queryText, blobRows = [], symbolRows = []) {
    if (!queryText || typeof queryText !== 'string') return [];

    const candidates = [];
    const seen = new Set();
    const pushCandidate = (ident) => {
        if (!ident || ident.length < 2) return;
        const lower = ident.toLowerCase();
        if (!seen.has(lower)) {
            seen.add(lower);
            candidates.push(ident);
        }
    };

    // 1. Backticked identifiers (`ident`)
    const backtickRegex = /`([^`\n]+)`/g;
    let btMatch;
    while ((btMatch = backtickRegex.exec(queryText)) !== null) {
        const inner = cleanCandidateToken(btMatch[1]);
        if (
            inner &&
            !/\s/.test(inner) &&
            /[a-zA-Z]/.test(inner) &&
            inner.length >= 2 &&
            !QUERY_STOPWORDS.has(inner.toLowerCase())
        ) {
            pushCandidate(inner);
        }
    }

    // 2. Non-backticked code-shaped tokens (ignoring plain lowercase words & prose hyphenations)
    const strippedBackticks = queryText.replace(/`[^`\n]*`/g, ' ');
    for (const rawTok of strippedBackticks.split(/\s+/).filter(Boolean)) {
        const cleaned = cleanCandidateToken(rawTok);
        if (!cleaned || cleaned.length < 2) continue;

        if (
            isCamelCaseIdentifier(cleaned) ||
            isPascalCaseIdentifier(cleaned) ||
            isSnakeCaseIdentifier(cleaned) ||
            isDottedOrFileIdentifier(cleaned) ||
            isSlashPathIdentifier(cleaned)
        ) {
            pushCandidate(cleaned);
        }
    }

    if (candidates.length === 0) return [];

    const haystackParts = [];
    if (Array.isArray(blobRows)) {
        for (const b of blobRows) {
            if (!b || typeof b !== 'object') continue;
            if (b.file_path) haystackParts.push(String(b.file_path));
            if (b.file_name) haystackParts.push(String(b.file_name));
            if (b.summary) haystackParts.push(String(b.summary));
            if (b.symbol_spine) haystackParts.push(String(b.symbol_spine));
        }
    }
    if (Array.isArray(symbolRows)) {
        for (const s of symbolRows) {
            if (!s || typeof s !== 'object') continue;
            if (s.symbol_name) haystackParts.push(String(s.symbol_name));
            if (s.signature) haystackParts.push(String(s.signature));
            if (s.file_path) haystackParts.push(String(s.file_path));
        }
    }

    const haystack = haystackParts.join('\n').toLowerCase();
    return candidates.filter((ident) => !haystack.includes(ident.toLowerCase()));
}

/**
 * Canonical 1-hop graph bridge SQL pattern (`WITH bridge_neighbors AS (...)`).
 *
 * Positional bind parameters:
 * - `$1::int[]`  : Distinct `repository_id`s of the Top-3 Hop-1 seed rows.
 * - `$2::text[]` : Normalized `file_path`s of the Top-3 Hop-1 seed rows.
 * - `$3::int`    : Maximum candidate neighbor rows to return (default `60`).
 */
export const BRIDGE_NEIGHBORS_SQL = `
WITH bridge_neighbors AS (
    SELECT
        e.id AS edge_id,
        e.repository_id,
        e.source_path AS seed_path,
        e.source_path AS edge_source_path,
        e.target_path,
        b.id,
        b.file_name,
        b.file_path,
        b.summary,
        b.symbol_spine,
        b.content,
        b.storage_mode,
        b.last_seen_at,
        b.created_at,
        e.relation,
        e.symbols AS edge_symbols
    FROM code_symbol_edges e
    JOIN blobs b
      ON b.repository_id = e.repository_id
     AND b.file_path IS NOT NULL
     AND b.file_path <> e.source_path
     AND (
         CASE
             WHEN e.target_path LIKE './%' THEN
                 b.file_path = (regexp_replace(e.source_path, '[^/]+$', '') || substring(e.target_path FROM 3))
                 OR b.file_path LIKE (regexp_replace(e.source_path, '[^/]+$', '') || substring(e.target_path FROM 3)) || '.%'
                 OR b.file_path = (regexp_replace(e.source_path, '[^/]+$', '') || substring(e.target_path FROM 3)) || '/index.js'
                 OR b.file_path = (regexp_replace(e.source_path, '[^/]+$', '') || substring(e.target_path FROM 3)) || '/index.ts'
             WHEN e.target_path LIKE '../%' THEN
                 b.file_path = regexp_replace(e.target_path, '^(\\.\\./)+', '')
                 OR b.file_path LIKE '%/' || regexp_replace(e.target_path, '^(\\.\\./)+', '')
                 OR b.file_path LIKE regexp_replace(e.target_path, '^(\\.\\./)+', '') || '.%'
                 OR b.file_path LIKE '%/' || regexp_replace(e.target_path, '^(\\.\\./)+', '') || '.%'
             ELSE
                 b.file_path = e.target_path
                 OR b.file_path LIKE '%/' || e.target_path
                 OR b.file_path LIKE e.target_path || '.%'
                 OR b.file_path LIKE '%/' || e.target_path || '.%'
         END
     )
    WHERE e.repository_id = ANY($1::int[])
      AND e.source_path = ANY($2::text[])

    UNION ALL

    SELECT
        e.id AS edge_id,
        e.repository_id,
        s.seed_path,
        e.source_path AS edge_source_path,
        e.target_path,
        b.id,
        b.file_name,
        b.file_path,
        b.summary,
        b.symbol_spine,
        b.content,
        b.storage_mode,
        b.last_seen_at,
        b.created_at,
        e.relation,
        e.symbols AS edge_symbols
    FROM code_symbol_edges e
    CROSS JOIN unnest($2::text[]) AS s(seed_path)
    JOIN blobs b
      ON b.repository_id = e.repository_id
     AND b.file_path = e.source_path
    WHERE e.repository_id = ANY($1::int[])
      AND e.source_path <> s.seed_path
      AND (
          CASE
              WHEN e.target_path LIKE './%' THEN
                  s.seed_path = (regexp_replace(e.source_path, '[^/]+$', '') || substring(e.target_path FROM 3))
                  OR s.seed_path LIKE (regexp_replace(e.source_path, '[^/]+$', '') || substring(e.target_path FROM 3)) || '.%'
                  OR s.seed_path = (regexp_replace(e.source_path, '[^/]+$', '') || substring(e.target_path FROM 3)) || '/index.js'
                  OR s.seed_path = (regexp_replace(e.source_path, '[^/]+$', '') || substring(e.target_path FROM 3)) || '/index.ts'
              WHEN e.target_path LIKE '../%' THEN
                  s.seed_path = regexp_replace(e.target_path, '^(\\.\\./)+', '')
                  OR s.seed_path LIKE '%/' || regexp_replace(e.target_path, '^(\\.\\./)+', '')
                  OR s.seed_path LIKE regexp_replace(e.target_path, '^(\\.\\./)+', '') || '.%'
                  OR s.seed_path LIKE '%/' || regexp_replace(e.target_path, '^(\\.\\./)+', '') || '.%'
              ELSE
                  s.seed_path = e.target_path
                  OR s.seed_path LIKE '%/' || e.target_path
                  OR s.seed_path LIKE e.target_path || '.%'
                  OR s.seed_path LIKE '%/' || e.target_path || '.%'
          END
      )
),
latest_neighbors AS (
    SELECT DISTINCT ON (n.repository_id, n.file_path, n.seed_path, n.edge_id)
        n.id,
        n.repository_id,
        r.name AS project,
        COALESCE(n.summary, substring(encode(n.content, 'escape') FROM 1 FOR 500)) AS summary,
        n.symbol_spine,
        n.storage_mode,
        n.last_seen_at,
        COALESCE(n.file_name, n.id) AS file_name,
        n.file_path,
        n.seed_path,
        n.edge_source_path,
        n.target_path,
        n.relation,
        n.edge_symbols
    FROM bridge_neighbors n
    JOIN repositories r ON r.id = n.repository_id
    ORDER BY n.repository_id, n.file_path, n.seed_path, n.edge_id, COALESCE(n.last_seen_at, n.created_at) DESC NULLS LAST, n.id DESC
)
SELECT * FROM latest_neighbors
LIMIT $3;
`;

function normalizeRepoPath(p) {
    return String(p || '').trim().replace(/^[/\\]+/, '');
}

function buildRowHaystack(row, includeEdgeSymbols = false) {
    if (!row || typeof row !== 'object') return { raw: '', collapsed: '' };
    const edgeSyms = includeEdgeSymbols
        ? (Array.isArray(row.edge_symbols)
            ? row.edge_symbols.join(' ')
            : (Array.isArray(row.symbols) ? row.symbols.join(' ') : String(row.edge_symbols || row.symbols || '')))
        : '';
    const raw = [
        row.file_path || '',
        row.file_name || '',
        row.summary || '',
        row.symbol_spine || '',
        edgeSyms
    ].join('\n').toLowerCase();
    return {
        raw,
        collapsed: raw.replace(/[_./-]+/g, '')
    };
}

function matchesQueryToken(hay, token) {
    if (!hay.raw || !token) return false;
    if (hay.raw.includes(token) || hay.collapsed.includes(token)) return true;

    if (token.length >= 5 && token.endsWith('ies')) {
        const singularY = `${token.slice(0, -3)}y`;
        if (hay.raw.includes(singularY) || hay.collapsed.includes(singularY)) return true;
    }
    if (token.length >= 4 && token.endsWith('y') && !/[aeiou]y$/.test(token)) {
        const pluralIes = `${token.slice(0, -1)}ies`;
        if (hay.raw.includes(pluralIes) || hay.collapsed.includes(pluralIes)) return true;
    }
    if (
        token.length >= 4 &&
        token.endsWith('s') &&
        !token.endsWith('ss') &&
        !token.endsWith('us') &&
        !token.endsWith('is')
    ) {
        const singular = token.slice(0, -1);
        if (hay.raw.includes(singular) || hay.collapsed.includes(singular)) return true;
    }
    return false;
}

function countCoveredTokens(row, tokens, includeEdgeSymbols = false) {
    if (!tokens || tokens.length === 0) return 0;
    const hay = buildRowHaystack(row, includeEdgeSymbols);
    let count = 0;
    for (const tok of tokens) {
        if (matchesQueryToken(hay, tok)) count++;
    }
    return count;
}

function verifyResolvedEdgeMatch(edgeSourcePath, edgeTargetPath, resolvedFilePath) {
    const src = normalizeRepoPath(edgeSourcePath);
    const tgt = String(edgeTargetPath || '').trim();
    const candidate = normalizeRepoPath(resolvedFilePath);
    if (!src || !tgt || !candidate) return true;
    if (tgt.startsWith('node:')) return false;
    if (tgt.startsWith('@') && !candidate.startsWith('@')) return false;

    const matchesCandidate = (resolvedTarget) => {
        const cleanTarget = resolvedTarget.replace(/^\.\//, '');
        if (!cleanTarget) return false;
        if (candidate === cleanTarget) return true;
        if (candidate.startsWith(`${cleanTarget}.`)) return true;
        if (candidate === `${cleanTarget}/index.js` || candidate === `${cleanTarget}/index.ts` || candidate.startsWith(`${cleanTarget}/index.`)) {
            return true;
        }
        return false;
    };

    if (tgt.startsWith('./') || tgt.startsWith('../')) {
        const srcDir = path.posix.dirname(src);
        const joined = path.posix.normalize(path.posix.join(srcDir === '.' ? '' : srcDir, tgt));
        if (!joined.startsWith('..')) {
            return matchesCandidate(joined);
        }
        const stripped = tgt.replace(/^(?:\.\.?\/)+/, '');
        const baseNoExt = path.posix.basename(stripped, path.posix.extname(stripped)).toLowerCase();
        if (GENERIC_BASENAMES.has(baseNoExt)) return false;
        return candidate === stripped || candidate.endsWith(`/${stripped}`) || candidate.endsWith(`/${stripped}.js`) || candidate.endsWith(`/${stripped}.ts`);
    }

    const cleanBare = normalizeRepoPath(tgt);
    if (matchesCandidate(cleanBare)) return true;
    const baseNoExt = path.posix.basename(cleanBare, path.posix.extname(cleanBare)).toLowerCase();
    if (GENERIC_BASENAMES.has(baseNoExt) && !cleanBare.includes('/')) {
        return false;
    }
    return (
        candidate.endsWith(`/${cleanBare}`) ||
        candidate.endsWith(`/${cleanBare}.js`) ||
        candidate.endsWith(`/${cleanBare}.ts`) ||
        candidate.endsWith(`/${cleanBare}.py`)
    );
}

/**
 * Expand Hop-1 blob search results with 1-hop `code_symbol_edges` neighbor blobs when
 * >=1 distinctive query token remains uncovered across Hop-1 (`INV-GIT-SEARCH-03`).
 *
 * Zero LLM calls and zero embedding RPCs. Executes 0 SQL queries when Hop-1 already
 * covers all distinctive query tokens.
 *
 * @param {Array<object>} hop1Rows
 * @param {string} queryText
 * @param {{ queryFn?: Function, repositoryId?: number|null, limit?: number }} [options={}]
 * @returns {Promise<Array<object>>}
 */
export async function expandCodeGraphBridges(hop1Rows, queryText, options = {}) {
    if (!Array.isArray(hop1Rows) || hop1Rows.length === 0 || typeof options?.queryFn !== 'function') {
        return hop1Rows;
    }
    if (!queryText || typeof queryText !== 'string' || !queryText.trim()) {
        return hop1Rows;
    }

    const { distinctiveTokens } = extractQueryIdentifiers(queryText);
    if (distinctiveTokens.length === 0) {
        return hop1Rows;
    }

    const hop1Haystacks = hop1Rows.map((row) => buildRowHaystack(row, false));
    const uncoveredTokens = distinctiveTokens.filter(
        (tok) => !hop1Haystacks.some((hay) => matchesQueryToken(hay, tok))
    );
    if (uncoveredTokens.length === 0) {
        return hop1Rows;
    }

    const scopedRepoId = options.repositoryId !== undefined && options.repositoryId !== null
        ? Number(options.repositoryId)
        : null;

    // Select up to Top-3 Hop-1 seed rows with valid repository_id and file_path
    const seeds = [];
    const seedByRepoPath = new Map();
    for (const row of hop1Rows) {
        if (!row || row.repository_id === undefined || row.repository_id === null || !row.file_path) {
            continue;
        }
        const repoId = Number(row.repository_id);
        if (scopedRepoId !== null && !Number.isNaN(scopedRepoId) && repoId !== scopedRepoId) {
            continue;
        }
        const cleanSeedPath = normalizeRepoPath(row.file_path);
        if (!cleanSeedPath) continue;
        const key = `${repoId}::${cleanSeedPath}`;
        if (!seedByRepoPath.has(key)) {
            const seedEntry = { repoId, filePath: cleanSeedPath, row, rankIndex: seeds.length };
            seedByRepoPath.set(key, seedEntry);
            seeds.push(seedEntry);
            if (seeds.length >= 3) break;
        }
    }

    if (seeds.length === 0) {
        return hop1Rows;
    }

    const safeLimit = Math.max(1, Number(options.limit) || 5);
    const neighborFetchLimit = Math.max(250, safeLimit * 50);
    const repoIds = [...new Set(seeds.map((s) => s.repoId))];
    const seedPaths = [...new Set(seeds.map((s) => s.filePath))];

    let dbRes;
    try {
        dbRes = await options.queryFn(BRIDGE_NEIGHBORS_SQL, [repoIds, seedPaths, neighborFetchLimit]);
    } catch (err) {
        if (err && err.code === '42703') {
            try {
                const legacySql = BRIDGE_NEIGHBORS_SQL
                    .replace(/b\.symbol_spine,/g, 'NULL::text AS symbol_spine,');
                dbRes = await options.queryFn(legacySql, [repoIds, seedPaths, neighborFetchLimit]);
            } catch (fallbackErr) {
                console.warn(`[graph-bridge] Fallback bridge query failed: ${fallbackErr?.message || fallbackErr}`);
                return hop1Rows;
            }
        } else {
            console.warn(`[graph-bridge] Bridge query failed: ${err?.message || err}`);
            return hop1Rows;
        }
    }

    const rawNeighbors = Array.isArray(dbRes?.rows) ? dbRes.rows : [];
    if (rawNeighbors.length === 0) {
        return hop1Rows;
    }

    const hop1Ids = new Set(hop1Rows.map((r) => r?.id).filter(Boolean));
    const hop1RepoPaths = new Set(
        hop1Rows
            .filter((r) => r && r.repository_id !== undefined && r.repository_id !== null && r.file_path)
            .map((r) => `${Number(r.repository_id)}::${normalizeRepoPath(r.file_path)}`)
    );

    const rawTopHop1Score = Number(hop1Rows[0]?.similarity);
    const topHop1Score = Number.isFinite(rawTopHop1Score) ? Math.max(0, rawTopHop1Score) : 0.5;
    const scoreCap = Math.min(topHop1Score * 0.84, 0.84);
    const bestByNeighborKey = new Map();

    for (const candidate of rawNeighbors) {
        if (!candidate || !candidate.file_path) continue;
        const repoId = Number(candidate.repository_id);
        if (scopedRepoId !== null && !Number.isNaN(scopedRepoId) && repoId !== scopedRepoId) {
            continue;
        }
        const neighborPath = normalizeRepoPath(candidate.file_path);
        const neighborKey = `${repoId}::${neighborPath}`;
        if (hop1Ids.has(candidate.id) || hop1RepoPaths.has(neighborKey)) {
            continue;
        }

        const seedPath = normalizeRepoPath(candidate.seed_path || seeds[0].filePath);
        const seedKey = `${repoId}::${seedPath}`;
        const seedInfo = seedByRepoPath.get(seedKey) || seeds.find((s) => s.repoId === repoId);
        if (!seedInfo) continue;

        // When edge metadata is returned, verify exact relative path resolution in POSIX space
        if (candidate.edge_source_path && candidate.target_path) {
            const edgeSrc = normalizeRepoPath(candidate.edge_source_path);
            const expectedTargetFile = edgeSrc === seedInfo.filePath ? neighborPath : seedInfo.filePath;
            if (!verifyResolvedEdgeMatch(edgeSrc, candidate.target_path, expectedTargetFile)) {
                continue;
            }
        }

        const hay = buildRowHaystack(candidate, true);
        let matchedUncovered = 0;
        for (const tok of uncoveredTokens) {
            if (matchesQueryToken(hay, tok)) matchedUncovered++;
        }
        if (matchedUncovered < 1) continue;

        let totalCovered = 0;
        for (const tok of distinctiveTokens) {
            if (matchesQueryToken(hay, tok)) totalCovered++;
        }

        const rawSeedSim = Number(seedInfo.row?.similarity);
        const seedSim = Number.isFinite(rawSeedSim) ? Math.max(0, rawSeedSim) : topHop1Score;
        const uncoveredRatio = uncoveredTokens.length > 0 ? matchedUncovered / uncoveredTokens.length : 1;
        const computedSim = Math.min(seedSim * (0.72 + 0.12 * Math.min(1, uncoveredRatio)), scoreCap);

        const bridgedRow = {
            id: candidate.id,
            repository_id: candidate.repository_id,
            project: candidate.project || seedInfo.row?.project,
            summary: candidate.summary ?? '',
            ...(candidate.symbol_spine !== undefined ? { symbol_spine: candidate.symbol_spine } : {}),
            storage_mode: candidate.storage_mode || 'pointer',
            last_seen_at: candidate.last_seen_at || null,
            file_name: candidate.file_name || path.posix.basename(neighborPath),
            file_path: candidate.file_path,
            similarity: computedSim,
            _isBridgeHop: true,
            _bridgeVia: seedInfo.filePath
        };

        const existing = bestByNeighborKey.get(neighborKey);
        if (
            !existing ||
            matchedUncovered > existing.matchedUncovered ||
            (matchedUncovered === existing.matchedUncovered && bridgedRow.similarity > existing.row.similarity)
        ) {
            bestByNeighborKey.set(neighborKey, {
                row: bridgedRow,
                matchedUncovered,
                totalCovered
            });
        }
    }

    if (bestByNeighborKey.size === 0) {
        return hop1Rows;
    }

    const rankedBridges = [...bestByNeighborKey.values()].sort((a, b) => {
        if (b.row.similarity !== a.row.similarity) return b.row.similarity - a.row.similarity;
        if (b.matchedUncovered !== a.matchedUncovered) return b.matchedUncovered - a.matchedUncovered;
        return b.totalCovered - a.totalCovered;
    });

    // Case 1: hop1Rows has spare capacity (< limit) -> append up to limit, sort DESC, slice to limit
    if (hop1Rows.length < safeLimit) {
        const slotsAvailable = safeLimit - hop1Rows.length;
        const selectedBridges = rankedBridges.slice(0, slotsAvailable).map((entry) => entry.row);
        return [...hop1Rows, ...selectedBridges]
            .sort((a, b) => (Number(b?.similarity) || 0) - (Number(a?.similarity) || 0))
            .slice(0, safeLimit);
    }

    // Case 2: hop1Rows.length >= limit -> preserve top Math.max(1, limit - 2) Hop-1 hits;
    // replace weakest tail hit(s) within capped top-limit only when the tail hit covers
    // strictly fewer query tokens than the bridge candidate.
    const working = hop1Rows.slice(0, safeLimit);
    if (working.length < safeLimit || safeLimit <= 1) {
        return working;
    }

    const protectedCount = Math.max(1, safeLimit - 2);
    const maxReplacements = safeLimit - protectedCount;
    let replacements = 0;

    for (const bridgeEntry of rankedBridges) {
        if (replacements >= maxReplacements) break;

        // Locate the weakest remaining non-bridge Hop-1 hit in the unprotected tail [protectedCount .. safeLimit - 1]
        let weakestIdx = -1;
        let weakestCovered = Infinity;
        let weakestSim = Infinity;

        for (let idx = protectedCount; idx < working.length; idx++) {
            const candidateTail = working[idx];
            if (candidateTail?._isBridgeHop) continue;
            const covered = countCoveredTokens(candidateTail, distinctiveTokens, false);
            const sim = Number(candidateTail?.similarity) || 0;
            if (
                covered < weakestCovered ||
                (covered === weakestCovered && (sim < weakestSim || (sim === weakestSim && idx > weakestIdx)))
            ) {
                weakestIdx = idx;
                weakestCovered = covered;
                weakestSim = sim;
            }
        }

        if (weakestIdx !== -1 && weakestCovered < bridgeEntry.totalCovered) {
            working[weakestIdx] = bridgeEntry.row;
            replacements++;
        }
    }

    return working
        .sort((a, b) => (Number(b?.similarity) || 0) - (Number(a?.similarity) || 0))
        .slice(0, safeLimit);
}
