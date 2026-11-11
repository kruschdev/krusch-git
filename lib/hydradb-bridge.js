import path from 'node:path';
import { existsSync } from 'node:fs';

let cachedCreateHydraDbClient = null;

function createStandaloneHydraFallbackClient({
  apiKey = '',
  baseUrl = 'https://api.hydradb.com/v2',
  database = 'krusch_git',
  collection = 'default',
} = {}) {
  const cleanKey = String(apiKey || '').trim();
  const parsedBase = new URL(String(baseUrl || 'https://api.hydradb.com/v2'));
  const cleanBase = parsedBase.href.replace(/\/+$/, '');
  return {
    isConfigured: () => cleanKey.length > 0,
    async ingestAppKnowledge(
      items,
      { database: db = database, collection: col = collection, upsert = true } = {}
    ) {
      const normalized = items.map((item, idx) => ({
        ...(item.id ? { id: String(item.id) } : {}),
        database: item.database || db,
        collection: item.collection || col,
        title: String(item.title || item.id || `knowledge-${idx + 1}`),
        type: String(item.type || 'document'),
        timestamp: item.timestamp || new Date().toISOString(),
        content: { text: String(item.content?.text ?? item.text ?? '').trim() },
        ...(item.metadata ? { metadata: item.metadata } : {}),
        ...(item.tenant_metadata ? { tenant_metadata: item.tenant_metadata } : {}),
        ...(item.additional_metadata ? { additional_metadata: item.additional_metadata } : {}),
        ...(item.relations ? { relations: item.relations } : {}),
      }));
      const form = new FormData();
      form.set('type', 'knowledge');
      form.set('database', db);
      if (col) form.set('collection', col);
      form.set('upsert', upsert ? 'true' : 'false');
      form.set('app_knowledge', JSON.stringify(normalized));
      const res = await fetch(`${cleanBase}/context/ingest`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${cleanKey}`, 'API-Version': '2' },
        body: form,
      });
      const json = await res.json();
      if (!res.ok || json?.success === false) {
        throw new Error(json?.error?.message || `HydraDB HTTP ${res.status}`);
      }
      return json?.data ?? json;
    },
    async queryContext({
      query,
      database: db = database,
      collection: col = collection,
      type = 'all',
      queryBy = 'hybrid',
      mode = 'fast',
      maxResults = 10,
      graphContext = true,
      queryForcefulRelations = true,
    } = {}) {
      const payload = {
        database: db,
        query: String(query || '').trim(),
        type,
        query_by: queryBy,
        mode,
        max_results: maxResults,
        graph_context: Boolean(graphContext),
        query_forceful_relations: Boolean(queryForcefulRelations),
        ...(col ? { collection: col } : {}),
      };
      const res = await fetch(`${cleanBase}/query`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${cleanKey}`,
          'API-Version': '2',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });
      const json = await res.json();
      if (!res.ok || json?.success === false) {
        throw new Error(json?.error?.message || `HydraDB HTTP ${res.status}`);
      }
      return json?.data ?? json;
    },
  };
}

async function loadHydraClientFactory() {
  if (cachedCreateHydraDbClient) return cachedCreateHydraDbClient;

  const siblingHydraUrl = new URL('../../../lib/hydradb.js', import.meta.url);
  if (existsSync(siblingHydraUrl)) {
    try {
      const mod = await import(siblingHydraUrl.href);
      if (typeof mod.createHydraDbClient === 'function') {
        cachedCreateHydraDbClient = mod.createHydraDbClient;
        return cachedCreateHydraDbClient;
      }
    } catch {
      // Fall through to @krusch/toolkit/hydradb
    }
  }

  try {
    const mod = await import('@krusch/toolkit/hydradb');
    if (typeof mod.createHydraDbClient === 'function') {
      cachedCreateHydraDbClient = mod.createHydraDbClient;
      return cachedCreateHydraDbClient;
    }
  } catch {
    // Use standalone native fetch fallback when toolkit is not installed
  }
  cachedCreateHydraDbClient = createStandaloneHydraFallbackClient;
  return cachedCreateHydraDbClient;
}

/**
 * Normalize repository identifier to a clean string.
 * @param {string|number|null|undefined} repoName
 * @returns {string}
 */
export function normalizeRepoCollection(repoName) {
  const clean = String(repoName ?? '')
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '_');
  return clean || 'default';
}

/**
 * Normalize relative file path using POSIX slashes.
 * @param {string} filePath
 * @returns {string}
 */
export function normalizePosixFilePath(filePath) {
  return String(filePath || '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\/+/, '');
}

/**
 * Deterministic HydraDB document ID for a repository file: `<repo>::<posixPath>`.
 * @param {string|number} repoName
 * @param {string} filePath
 * @returns {string}
 */
export function formatHydraCodeDocId(repoName, filePath) {
  const safeRepo = normalizeRepoCollection(repoName);
  const cleanPath = normalizePosixFilePath(filePath);
  return `${safeRepo}::${cleanPath}`;
}

/**
 * Resolve a relative or repo-local import target path against the importing file's directory
 * into a deterministic HydraDB document ID (`<repo>::<resolvedPosixPath>`).
 * Returns `null` for external bare npm/pip specifiers unless `includeExternal` is true.
 *
 * @param {string|number} repoName
 * @param {string} sourceFilePath
 * @param {string} importTargetPath
 * @param {object} [options]
 * @param {boolean} [options.includeExternal]
 * @returns {string|null}
 */
export function resolveImportTargetDocId(
  repoName,
  sourceFilePath,
  importTargetPath,
  { includeExternal = false } = {}
) {
  const safeRepo = normalizeRepoCollection(repoName);
  const rawTarget = String(importTargetPath || '').trim().replace(/\\/g, '/');
  if (!rawTarget) return null;

  const cleanSource = normalizePosixFilePath(sourceFilePath);
  const sourceDir = path.posix.dirname(cleanSource);

  if (rawTarget.startsWith('./') || rawTarget.startsWith('../')) {
    const joined =
      sourceDir && sourceDir !== '.'
        ? path.posix.normalize(`${sourceDir}/${rawTarget}`)
        : path.posix.normalize(rawTarget);
    const stripped = joined.replace(/^(\.\.\/)+/, '').replace(/^\/+/, '');
    return `${safeRepo}::${stripped}`;
  }

  if (rawTarget.startsWith('/')) {
    return `${safeRepo}::${rawTarget.replace(/^\/+/, '')}`;
  }

  if (includeExternal) {
    return `${safeRepo}::pkg:${rawTarget}`;
  }

  return null;
}

/**
 * Returns true when HydraDB code-graph sync/fallback is configured.
 * @param {object} [options]
 * @returns {boolean}
 */
export function isHydraGitEnabled(options = {}) {
  if (options.hydraClient && typeof options.hydraClient.isConfigured === 'function') {
    return Boolean(options.hydraClient.isConfigured());
  }
  const apiKey = options.apiKey || process.env.HYDRADB_API_KEY || '';
  if (!apiKey) return false;
  if (options.requireSyncFlag === true) {
    return process.env.HYDRADB_GIT_SYNC === 'true';
  }
  return true;
}

/**
 * Instantiate a HydraDbClient configured for KruschGit AST & dependency graphs.
 * @param {object} [options]
 */
export async function getHydraGitClient(options = {}) {
  if (options.hydraClient) return options.hydraClient;
  const createClient = await loadHydraClientFactory();
  if (!createClient) return null;
  return createClient({
    apiKey: options.apiKey || process.env.HYDRADB_API_KEY || '',
    baseUrl: options.baseUrl || process.env.HYDRADB_BASE_URL || undefined,
    database:
      options.database ||
      process.env.HYDRADB_GIT_DATABASE ||
      process.env.HYDRADB_DATABASE ||
      'krusch_git',
    collection: normalizeRepoCollection(
      options.collection || options.repoName || process.env.HYDRADB_COLLECTION || 'default'
    ),
  });
}

/**
 * Synchronize a file's AST symbol spine, symbol declarations, and import dependency edges
 * into HydraDB (`app_knowledge`) with explicit `relations.ids` (`IMPORTS` edges).
 *
 * @param {object} params
 * @param {string|number} params.repoName
 * @param {string} params.relativePath
 * @param {string} [params.sha]
 * @param {string} [params.summary]
 * @param {string} [params.symbolSpine]
 * @param {Array<object>} [params.symbols]
 * @param {Array<object>} [params.imports]
 * @param {object} [params.hydraClient]
 */
export async function syncFileAstToHydraDb({
  repoName,
  relativePath,
  sha = '',
  summary = '',
  symbolSpine = '',
  symbols = [],
  imports = [],
  hydraClient = null,
} = {}) {
  const client = await getHydraGitClient({ hydraClient, repoName });
  if (!client || !client.isConfigured()) {
    return { synced: false, reason: 'hydradb_not_configured' };
  }

  const safeRepo = normalizeRepoCollection(repoName);
  const cleanPath = normalizePosixFilePath(relativePath);
  const docId = formatHydraCodeDocId(safeRepo, cleanPath);

  const relationIds = [];
  const seenTargets = new Set();
  const normalizedImports = [];

  for (const imp of Array.isArray(imports) ? imports : []) {
    if (!imp || typeof imp !== 'object') continue;
    const targetPath = String(imp.targetPath || imp.target_path || '').trim();
    if (!targetPath) continue;
    const relation = String(imp.relation || 'IMPORTS').trim();
    const symList = imp.symbols || '';
    normalizedImports.push({
      target_path: targetPath,
      relation,
      symbols: symList,
    });

    const targetDocId = resolveImportTargetDocId(safeRepo, cleanPath, targetPath);
    if (targetDocId && !seenTargets.has(targetDocId)) {
      seenTargets.add(targetDocId);
      relationIds.push(targetDocId);
    }
  }

  const compactSymbols = (Array.isArray(symbols) ? symbols : [])
    .slice(0, 60)
    .map((s) => ({
      symbol_name: String(s.name || s.symbol_name || '').trim(),
      symbol_type: String(s.type || s.symbol_type || 'symbol').trim(),
      start_line: Number(s.startLine ?? s.start_line ?? 1),
      end_line: Number(s.endLine ?? s.end_line ?? 1),
      signature: String(s.signature || '').trim(),
      symbol_hash: String(s.symbol_hash || s.symbolHash || '').trim(),
    }))
    .filter((s) => s.symbol_name);

  const symbolLines = compactSymbols.map(
    (s) =>
      `- [${s.symbol_type}] ${s.symbol_name} (L${s.start_line}-L${s.end_line})${
        s.signature ? `: ${s.signature}` : ''
      }`
  );
  const importLines = normalizedImports.map(
    (i) => `- ${i.relation} ${i.target_path}${i.symbols ? ` (${i.symbols})` : ''}`
  );

  const textSections = [
    `File: ${cleanPath} (Repo: ${safeRepo})`,
    summary ? `Summary: ${summary}` : '',
    symbolSpine ? `Symbol Spine: ${symbolSpine}` : '',
    symbolLines.length > 0 ? `AST Symbols:\n${symbolLines.join('\n')}` : '',
    importLines.length > 0 ? `Dependency Edges:\n${importLines.join('\n')}` : '',
  ].filter(Boolean);

  const knowledgeItem = {
    id: docId,
    title: `${safeRepo}/${cleanPath}`,
    text: textSections.join('\n\n'),
    metadata: {
      repo: safeRepo,
      file_path: cleanPath,
      blob_id: String(sha || ''),
      symbol_spine: String(symbolSpine || ''),
      symbols_json: JSON.stringify(compactSymbols),
      imports_json: JSON.stringify(normalizedImports),
    },
    ...(relationIds.length > 0
      ? {
          relations: {
            ids: relationIds,
            properties: {
              edge_type: 'IMPORTS',
              source_path: cleanPath,
            },
          },
        }
      : {}),
  };

  const response = await client.ingestAppKnowledge([knowledgeItem], {
    collection: safeRepo,
  });

  return {
    synced: true,
    docId,
    relationIds,
    symbolCount: compactSymbols.length,
    importCount: normalizedImports.length,
    response,
  };
}

/**
 * Query HydraDB for code blobs + AST graph relations when PostgreSQL is unreachable on the road.
 *
 * @param {string} queryText
 * @param {number} [limit=5]
 * @param {string|number|null} [repoName=null]
 * @param {object} [options]
 * @returns {Promise<Array<object>>}
 */
export async function searchHydraCodeBlobs(
  queryText,
  limit = 5,
  repoName = null,
  options = {}
) {
  const cleanQuery = String(queryText || '').trim();
  if (!cleanQuery) return [];

  const client = await getHydraGitClient({
    hydraClient: options.hydraClient,
    repoName: repoName || undefined,
  });
  if (!client || !client.isConfigured()) return [];

  const safeLimit = Math.max(1, Math.min(Number(limit) || 5, 50));
  const collection =
    repoName !== null && repoName !== undefined && String(repoName).trim() !== ''
      ? normalizeRepoCollection(repoName)
      : undefined;

  const res = await client.queryContext({
    query: cleanQuery,
    collection,
    mode: options.mode || 'fast',
    maxResults: safeLimit,
    graphContext: true,
    queryForcefulRelations: true,
  });

  const chunks = Array.isArray(res?.chunks) ? res.chunks : [];
  return chunks.slice(0, safeLimit).map((chunk, idx) => {
    const meta = chunk.metadata || {};
    const sourceId = String(chunk.source_id || chunk.id || `hydra-${idx}`);
    const parsedPath =
      meta.file_path ||
      (sourceId.includes('::') ? sourceId.split('::').slice(1).join('::') : sourceId);
    const parsedRepo =
      meta.repo ||
      (sourceId.includes('::') ? sourceId.split('::')[0] : collection || 'default');

    return {
      id: meta.blob_id || sourceId,
      repository_id: typeof repoName === 'number' ? repoName : null,
      project: parsedRepo,
      summary: chunk.text || chunk.content || chunk.title || '',
      symbol_spine: meta.symbol_spine || null,
      storage_mode: 'hydradb',
      file_name: path.posix.basename(parsedPath),
      file_path: parsedPath,
      similarity: Number(chunk.score ?? Math.max(0.5, 0.95 - idx * 0.05)),
      hydra_graph_context: res.graph_context || null,
    };
  });
}

/**
 * Reconstruct a file's AST symbol and dependency graph (`{ filePath, repositoryId, symbols, imports, dependents }`)
 * from HydraDB when PostgreSQL is offline.
 *
 * @param {string} filePath
 * @param {string|number|null} repositoryId
 * @param {object} [options]
 */
export async function getHydraSymbolGraph(
  filePath,
  repositoryId = null,
  options = {}
) {
  const cleanFilePath = normalizePosixFilePath(filePath);
  if (!cleanFilePath) {
    return { filePath: '', repositoryId, symbols: [], imports: [], dependents: [] };
  }

  const repoName = options.repoName || repositoryId || 'default';
  const safeRepo = normalizeRepoCollection(repoName);
  const client = await getHydraGitClient({
    hydraClient: options.hydraClient,
    repoName: safeRepo,
  });
  if (!client || !client.isConfigured()) {
    return {
      filePath: cleanFilePath,
      repositoryId,
      symbols: [],
      imports: [],
      dependents: [],
    };
  }

  const docId = formatHydraCodeDocId(safeRepo, cleanFilePath);
  const res = await client.queryContext({
    query: `${cleanFilePath} ${docId}`,
    collection: safeRepo,
    mode: 'fast',
    maxResults: 10,
    graphContext: true,
    queryForcefulRelations: true,
  });

  let symbols = [];
  let imports = [];
  const dependents = [];
  const seenDependents = new Set();

  const chunks = Array.isArray(res?.chunks) ? res.chunks : [];
  for (const chunk of chunks) {
    const meta = chunk.metadata || {};
    const chunkPath = normalizePosixFilePath(
      meta.file_path ||
        (String(chunk.source_id || '').includes('::')
          ? String(chunk.source_id).split('::').slice(1).join('::')
          : '')
    );

    if (chunkPath === cleanFilePath) {
      if (symbols.length === 0 && typeof meta.symbols_json === 'string') {
        try {
          symbols = JSON.parse(meta.symbols_json);
        } catch {
          symbols = [];
        }
      }
      if (imports.length === 0 && typeof meta.imports_json === 'string') {
        try {
          imports = JSON.parse(meta.imports_json);
        } catch {
          imports = [];
        }
      }
    } else if (chunkPath && typeof meta.imports_json === 'string') {
      try {
        const peerImports = JSON.parse(meta.imports_json);
        for (const imp of Array.isArray(peerImports) ? peerImports : []) {
          const resolved = resolveImportTargetDocId(
            safeRepo,
            chunkPath,
            imp.target_path || imp.targetPath
          );
          if (resolved === docId && !seenDependents.has(chunkPath)) {
            seenDependents.add(chunkPath);
            dependents.push({
              source_path: chunkPath,
              relation: imp.relation || 'IMPORTS',
              symbols: imp.symbols || '',
            });
          }
        }
      } catch {
        // Ignore malformed peer imports_json
      }
    }
  }

  const chunkRelations = Array.isArray(res?.graph_context?.chunk_relations)
    ? res.graph_context.chunk_relations
    : [];
  for (const rel of chunkRelations) {
    const src = String(rel.source || rel.from || '').trim();
    const tgt = String(rel.target || rel.to || '').trim();
    const srcPath = src.includes('::') ? src.split('::').slice(1).join('::') : src;
    const tgtPath = tgt.includes('::') ? tgt.split('::').slice(1).join('::') : tgt;

    if (
      tgtPath &&
      (tgt === docId || tgtPath === cleanFilePath) &&
      srcPath &&
      srcPath !== cleanFilePath &&
      !seenDependents.has(srcPath)
    ) {
      seenDependents.add(srcPath);
      dependents.push({
        source_path: srcPath,
        relation: String(rel.relation || rel.type || 'IMPORTS'),
        symbols: '',
      });
    }
  }

  return {
    filePath: cleanFilePath,
    repositoryId,
    symbols,
    imports,
    dependents,
    storage_mode: 'hydradb',
  };
}
