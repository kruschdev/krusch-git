import test, { after } from 'node:test';
import assert from 'node:assert';
import { createRepository, insertBlob, getBlob } from '../server/git-engine.js';
import { populateSymbolsAndEdges } from '../scripts/sync_to_pg.js';
import { pool } from '../db/pool.js';

test('BUG-01: getBlob retrieves blob metadata and joined repository project name', async () => {
    const repoName = `getblob-test-repo-${Date.now()}`;
    const repo = await createRepository(repoName, 'Test repository for getBlob');
    assert.ok(repo && repo.id);

    try {
        const contentBuf = Buffer.from(`// test getBlob content ${Date.now()}\n`);
        const sha = await insertBlob(repo.id, contentBuf);
        assert.ok(sha);

        const row = await getBlob(sha);
        assert.ok(row, 'Expected getBlob to return the inserted blob row');
        assert.strictEqual(row.id, sha);
        assert.strictEqual(Number(row.repository_id), Number(repo.id));
        assert.strictEqual(row.project, repoName);

        const missing = await getBlob('non-existent-blob-id-00000000000000000000');
        assert.strictEqual(missing, null);

        await assert.rejects(
            () => getBlob('any-blob-id', async () => {
                throw new Error('connection terminated unexpectedly');
            }),
            /Database query failed/
        );
    } finally {
        await pool.query('DELETE FROM blobs WHERE repository_id = $1', [repo.id]).catch(() => {});
        await pool.query('DELETE FROM repositories WHERE id = $1', [repo.id]).catch(() => {});
    }
});

test('BUG-01 / TEST-01: populateSymbolsAndEdges rolls back transaction and propagates extraction errors', async () => {
    const queries = [];
    let released = false;
    const mockPool = {
        connect: async () => ({
            query: async (sql) => {
                queries.push(sql.trim());
                return { rows: [] };
            },
            release: () => {
                released = true;
            }
        })
    };

    await assert.rejects(
        () => populateSymbolsAndEdges(
            'sha-123',
            1,
            Buffer.from('export function broken() {}'),
            'src/broken.js',
            '.js',
            {
                poolImpl: mockPool,
                extractFn: () => {
                    throw new Error('Synthetic AST failure');
                }
            }
        ),
        /Synthetic AST failure/
    );

    assert.ok(queries.includes('ROLLBACK'), 'Expected transaction ROLLBACK on extraction failure');
    assert.strictEqual(released, true, 'Expected DB client to be released in finally block');
});

after(async () => {
    await pool.end();
});

