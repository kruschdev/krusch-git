import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {
  formatHydraCodeDocId,
  resolveImportTargetDocId,
  getHydraGitClient,
  syncFileAstToHydraDb,
  searchHydraCodeBlobs,
  getHydraSymbolGraph,
} from '../lib/hydradb-bridge.js';
import { getSymbolGraph } from '../server/git-engine.js';

function startMockHydraServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      resolve({
        server,
        baseUrl: `http://127.0.0.1:${addr.port}`,
        close: () => new Promise((res) => server.close(res)),
      });
    });
  });
}

test('HydraDB AST & Dependency-Edge Bridge: deterministic doc IDs, relative import resolution, ingest, and road-mode graph fallback', async () => {
  assert.equal(
    formatHydraCodeDocId('krusch-stack', 'src/fee-engine.js'),
    'krusch-stack::src/fee-engine.js'
  );
  assert.equal(
    resolveImportTargetDocId('krusch-stack', 'src/fee-engine.js', './sox-reconciler.js'),
    'krusch-stack::src/sox-reconciler.js'
  );
  assert.equal(
    resolveImportTargetDocId('krusch-stack', 'src/api/routes.js', '../fee-engine.js'),
    'krusch-stack::src/fee-engine.js'
  );
  assert.equal(
    resolveImportTargetDocId('krusch-stack', 'src/fee-engine.js', 'express'),
    null
  );

  const ingestedDocuments = [];
  const mock = await startMockHydraServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const bodyStr = Buffer.concat(chunks).toString('utf8');
      res.setHeader('Content-Type', 'application/json');

      if (req.url === '/context/ingest' && req.method === 'POST') {
        const match = bodyStr.match(/name="app_knowledge"\r?\n\r?\n([\s\S]*?)\r?\n--/);
        const appKnowledge = match ? JSON.parse(match[1].trim()) : [];
        ingestedDocuments.push({ app_knowledge: appKnowledge, rawBody: bodyStr });
        res.end(
          JSON.stringify({
            success: true,
            data: { accepted: true, ids: appKnowledge.map((k) => k.id) },
            error: null,
          })
        );
        return;
      }

      if (req.url === '/query' && req.method === 'POST') {
        res.end(
          JSON.stringify({
            success: true,
            data: {
              chunks: [
                {
                  id: 'chk-1',
                  source_id: 'krusch-stack::src/fee-engine.js',
                  title: 'krusch-stack/src/fee-engine.js',
                  score: 0.96,
                  text: 'File: src/fee-engine.js\nSymbol Spine: calculateLedgerFee',
                  metadata: {
                    repo: 'krusch-stack',
                    file_path: 'src/fee-engine.js',
                    blob_id: 'sha_fee_123',
                    symbol_spine: 'calculateLedgerFee',
                    symbols_json: JSON.stringify([
                      {
                        symbol_name: 'calculateLedgerFee',
                        symbol_type: 'function',
                        start_line: 12,
                        end_line: 48,
                        signature: 'export function calculateLedgerFee(tx)',
                        symbol_hash: 'h_fee_01',
                      },
                    ]),
                    imports_json: JSON.stringify([
                      {
                        target_path: './sox-reconciler.js',
                        relation: 'IMPORTS',
                        symbols: 'reconcileSoxLedger',
                      },
                    ]),
                  },
                },
                {
                  id: 'chk-2',
                  source_id: 'krusch-stack::src/api/routes.js',
                  title: 'krusch-stack/src/api/routes.js',
                  score: 0.88,
                  text: 'File: src/api/routes.js',
                  metadata: {
                    repo: 'krusch-stack',
                    file_path: 'src/api/routes.js',
                    imports_json: JSON.stringify([
                      {
                        target_path: '../fee-engine.js',
                        relation: 'IMPORTS',
                        symbols: 'calculateLedgerFee',
                      },
                    ]),
                  },
                },
              ],
              graph_context: {
                query_paths: [
                  'krusch-stack::src/api/routes.js --[IMPORTS]--> krusch-stack::src/fee-engine.js --[IMPORTS]--> krusch-stack::src/sox-reconciler.js',
                ],
                chunk_relations: [],
              },
            },
            error: null,
          })
        );
        return;
      }

      res.end(JSON.stringify({ success: true, data: {}, error: null }));
    });
  });

  try {
    const hydraClient = await getHydraGitClient({
      apiKey: 'hydra_git_test_key',
      baseUrl: mock.baseUrl,
      database: 'krusch_git',
      collection: 'krusch-stack',
    });

    const syncRes = await syncFileAstToHydraDb({
      repoName: 'krusch-stack',
      relativePath: 'src/fee-engine.js',
      sha: 'sha_fee_123',
      summary: 'Calculates deterministic ledger fees',
      symbolSpine: 'calculateLedgerFee',
      symbols: [
        {
          name: 'calculateLedgerFee',
          type: 'function',
          startLine: 12,
          endLine: 48,
          signature: 'export function calculateLedgerFee(tx)',
          symbol_hash: 'h_fee_01',
        },
      ],
      imports: [
        {
          targetPath: './sox-reconciler.js',
          relation: 'IMPORTS',
          symbols: 'reconcileSoxLedger',
        },
        {
          targetPath: 'express',
          relation: 'IMPORTS',
          symbols: 'Router',
        },
      ],
      hydraClient,
    });

    assert.equal(syncRes.synced, true);
    assert.equal(syncRes.docId, 'krusch-stack::src/fee-engine.js');
    assert.deepEqual(syncRes.relationIds, ['krusch-stack::src/sox-reconciler.js']);
    assert.equal(ingestedDocuments.length, 1);
    assert.equal(
      ingestedDocuments[0].app_knowledge[0].relations.ids[0],
      'krusch-stack::src/sox-reconciler.js'
    );

    const blobHits = await searchHydraCodeBlobs('calculateLedgerFee', 5, 'krusch-stack', {
      hydraClient,
    });
    assert.equal(blobHits.length, 2);
    assert.equal(blobHits[0].file_path, 'src/fee-engine.js');
    assert.equal(blobHits[0].storage_mode, 'hydradb');

    // Verify getSymbolGraph falls back to HydraDB when PostgreSQL throws
    const offlineGraph = await getSymbolGraph('src/fee-engine.js', 1, {
      queryFn: async () => {
        throw new Error('connect ECONNREFUSED 127.0.0.1:5432');
      },
      hydraClient,
      repoName: 'krusch-stack',
    });
    assert.equal(offlineGraph.filePath, 'src/fee-engine.js');
    assert.equal(offlineGraph.storage_mode, 'hydradb');
    assert.equal(offlineGraph.symbols.length, 1);
    assert.equal(offlineGraph.symbols[0].symbol_name, 'calculateLedgerFee');
    assert.equal(offlineGraph.imports.length, 1);
    assert.equal(offlineGraph.imports[0].target_path, './sox-reconciler.js');
    assert.equal(offlineGraph.dependents.length, 1);
    assert.equal(offlineGraph.dependents[0].source_path, 'src/api/routes.js');
  } finally {
    await mock.close();
  }
});
