import test from 'node:test';
import assert from 'node:assert';
import { server } from '../server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

test('MCP Server: exposes canonical krusch_git_* tools and aliases pg_git_*', async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    await server.connect(serverTransport);

    const client = new Client(
        { name: 'test-client', version: '1.0.0' },
        { capabilities: {} }
    );
    await client.connect(clientTransport);

    try {
        // 1. Check tools list
        const { tools } = await client.listTools();
        assert.ok(Array.isArray(tools), 'tools should be an array');
        assert.strictEqual(tools.length, 7, 'Should advertise exactly 7 tools');

        const toolNames = tools.map(t => t.name).sort();
        const expected = [
            'krusch_git_dependency_graph',
            'krusch_git_file_symbols',
            'krusch_git_list_repos',
            'krusch_git_read_blob',
            'krusch_git_read_tree',
            'krusch_git_search_symbols',
            'krusch_git_semantic_search'
        ];
        assert.deepStrictEqual(toolNames, expected, 'All advertised tools must use krusch_git_* prefix');

        // 2. Call canonical tool
        const resCanonical = await client.callTool({
            name: 'krusch_git_list_repos',
            arguments: {}
        });
        assert.ok(resCanonical.content && resCanonical.content.length > 0);
        assert.ok(!resCanonical.isError, 'Canonical tool call should succeed');

        // 3. Call legacy aliased tool (pg_git_list_repos)
        const resLegacy = await client.callTool({
            name: 'pg_git_list_repos',
            arguments: {}
        });
        assert.ok(resLegacy.content && resLegacy.content.length > 0);
        assert.ok(!resLegacy.isError, 'Legacy aliased tool call should succeed');
        assert.deepStrictEqual(resLegacy.content, resCanonical.content, 'Alias should produce identical output');

    } finally {
        await client.close();
        await server.close();
    }
});
