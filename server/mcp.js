#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ErrorCode,
  McpError
} from "@modelcontextprotocol/sdk/types.js";

import { 
    getRepositories, 
    getTreeEntries, 
    getBlob, 
    getRepoRootTree,
    searchBlobs,
    searchSymbols,
    getSymbolsForBlob,
    getSymbolGraph,
    resolveBlobContent
} from './git-engine.js';

import { getEmbedding } from '../lib/embedding.js';
import { pool } from '../db/pool.js';

// ── Health Check ──────────────────────────────────────────────────────────────
async function verifyDatabase() {
    try {
        await pool.query('SELECT 1');
        console.error('[pg-git-mcp] Database connection verified.');
    } catch (err) {
        console.error('[pg-git-mcp] FATAL: Cannot reach PostgreSQL:', err.message);
        process.exit(1);
    }
}

// ── MCP Server ────────────────────────────────────────────────────────────────
const server = new Server(
    { name: "pg-git-mcp", version: "1.1.0" },
    { capabilities: { tools: {} } }
);


server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
        tools: [
            {
                name: "pg_git_list_repos",
                description: "List all available PG-Git repositories stored in the database.",
                inputSchema: { type: "object", properties: {} }
            },
            {
                name: "pg_git_read_tree",
                description: "Read the directory structure (DAG node) of a specific repository. If tree_id is omitted, it attempts to read the root tree of the 'main' branch.",
                inputSchema: {
                    type: "object",
                    properties: {
                        repository_id: { type: "number", description: "The ID of the repository." },
                        tree_id: { type: "string", description: "The specific SHA-1 tree hash. Leave empty for root." }
                    },
                    required: ["repository_id"]
                }
            },
            {
                name: "pg_git_read_blob",
                description: "Read the file contents of a specific blob.",
                inputSchema: {
                    type: "object",
                    properties: {
                        blob_id: { type: "string", description: "The SHA-1 hash of the blob." }
                    },
                    required: ["blob_id"]
                }
            },
            {
                name: "pg_git_semantic_search",
                description: "Search code files in PG-Git using Hybrid RRF (BM25 + pgvector), pure semantic vector, or keyword search. Results are decayed by age.",
                inputSchema: {
                    type: "object",
                    properties: {
                        query: { type: "string", description: "The search query." },
                        search_type: { 
                            type: "string", 
                            enum: ["hybrid", "semantic", "keyword"], 
                            description: "Search mode: 'hybrid' (BM25 + pgvector RRF, default), 'semantic' (pure vector), or 'keyword' (pure BM25).",
                            default: "hybrid" 
                        },
                        limit: { type: "number", description: "Number of results to return.", default: 5 },
                        project: { type: "string", description: "Optional project name to filter search (e.g., 'annotated', 'signet', 'krusch-dbos-mcp')." },
                        repository_id: { type: "number", description: "Optional repository ID to limit search to a specific repo." }
                    },
                    required: ["query"]
                }
            },
            {
                name: "pg_git_search_symbols",
                description: "Search for specific code symbols (functions, classes, methods, routes) across repositories with exact match boost, signatures, and line ranges.",
                inputSchema: {
                    type: "object",
                    properties: {
                        query: { type: "string", description: "Function, class, or symbol name to search for." },
                        symbol_type: { type: "string", enum: ["function", "class", "method", "route", "type", "variable"], description: "Optional filter for symbol type." },
                        limit: { type: "number", description: "Max symbols to return.", default: 10 },
                        project: { type: "string", description: "Optional project name to filter search." },
                        repository_id: { type: "number", description: "Optional repository ID." }
                    },
                    required: ["query"]
                }
            },
            {
                name: "pg_git_file_symbols",
                description: "List all code symbols (functions, classes, methods, routes) declared inside a specific file blob.",
                inputSchema: {
                    type: "object",
                    properties: {
                        blob_id: { type: "string", description: "The SHA-1 hash of the blob." }
                    },
                    required: ["blob_id"]
                }
            },
            {
                name: "pg_git_dependency_graph",
                description: "Trace symbol dependencies: retrieve outbound imports, inbound callers/dependents, and declared symbols for a specific file path.",
                inputSchema: {
                    type: "object",
                    properties: {
                        file_path: { type: "string", description: "Relative file path (e.g., 'server/git-engine.js')." },
                        repository_id: { type: "number", description: "Repository ID." },
                        project: { type: "string", description: "Optional project name (if repository_id not provided)." }
                    },
                    required: ["file_path"]
                }
            }
        ]
    };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const args = request.params.arguments || {};
    try {
        if (request.params.name === "pg_git_list_repos") {
            const repos = await getRepositories();
            const output = repos.map(r => `ID: ${r.id} | Name: ${r.name} | Desc: ${r.description}`).join('\n');
            return {
                content: [{ type: "text", text: output || "No repositories found." }]
            };
        } else if (request.params.name === "pg_git_read_tree") {
            const { repository_id, tree_id } = args;
            let targetTree = tree_id;
            
            if (!targetTree) {
                targetTree = await getRepoRootTree(repository_id);
                if (!targetTree) {
                    return { content: [{ type: "text", text: "No 'main' branch or root tree found for this repository. It may be empty." }] };
                }
            }
            
            const entries = await getTreeEntries(targetTree);
            if (!entries || entries.length === 0) {
                return { content: [{ type: "text", text: `Tree ${targetTree} is empty or does not exist.` }] };
            }
            
            const output = entries.map(e => `[${e.type.toUpperCase()}] ${e.name} (Object ID: ${e.object_id})`).join('\n');
            return { content: [{ type: "text", text: `Tree contents for ${targetTree}:\n\n${output}` }] };

        } else if (request.params.name === "pg_git_read_blob") {
            const { blob_id } = args;
            const blob = await getBlob(blob_id);
            if (!blob) {
                throw new McpError(ErrorCode.InvalidParams, `Blob ${blob_id} not found.`);
            }
            
            const buffer = await resolveBlobContent(blob);
            if (!buffer) {
                throw new McpError(ErrorCode.InternalError, `Failed to resolve content for blob ${blob_id}.`);
            }
            const textContent = buffer.toString('utf-8');
            return { content: [{ type: "text", text: textContent }] };
            
        } else if (request.params.name === "pg_git_semantic_search") {
            const { query: searchQuery, limit = 5, repository_id, project, search_type = "hybrid" } = args;
            
            // Resolve project name to repository_id if provided
            let resolvedRepoId = repository_id;
            if (project && !resolvedRepoId) {
                const repoRes = await pool.query(`SELECT id FROM repositories WHERE name = $1`, [project]);
                if (repoRes.rows.length > 0) {
                    resolvedRepoId = repoRes.rows[0].id;
                }
            }
            
            let vector = null;
            if (search_type !== "keyword") {
                vector = await getEmbedding(searchQuery);
            }
            
            const results = await searchBlobs(searchQuery, limit, resolvedRepoId, {
                search_type,
                vector
            });
            
            if (results.length === 0) {
                return { content: [{ type: "text", text: "No relevant files found." }] };
            }
            
            let output = `=== 🔍 ${search_type.toUpperCase()} Search Results ===\n`;
            for (const r of results) {
                const dateStr = r.last_seen_at ? new Date(r.last_seen_at).toISOString().split('T')[0] : 'unknown';
                const projectTag = r.project ? `[${r.project}]` : '';
                const pathStr = r.file_path ? ` | Path: ${r.file_path}` : '';
                output += `\n--- Match (Score: ${Number(r.similarity).toFixed(3)}) | ${projectTag} ${r.file_name}${pathStr} | Seen: ${dateStr} ---\n`;
                output += (r.summary || '(no preview)') + '\n';
            }
            return { content: [{ type: "text", text: output }] };

        } else if (request.params.name === "pg_git_search_symbols") {
            const { query: searchQuery, limit = 10, repository_id, project, symbol_type } = args;
            
            let resolvedRepoId = repository_id;
            if (project && !resolvedRepoId) {
                const repoRes = await pool.query(`SELECT id FROM repositories WHERE name = $1`, [project]);
                if (repoRes.rows.length > 0) {
                    resolvedRepoId = repoRes.rows[0].id;
                }
            }

            const symbols = await searchSymbols(searchQuery, limit, resolvedRepoId, { symbol_type });
            if (symbols.length === 0) {
                return { content: [{ type: "text", text: `No symbols matching '${searchQuery}' found.` }] };
            }

            let output = `=== 🧩 Code Symbols Matching '${searchQuery}' ===\n`;
            for (const s of symbols) {
                const proj = s.project ? `[${s.project}] ` : '';
                output += `\n--- ${proj}${s.file_path}:${s.start_line}-${s.end_line} | ${s.symbol_type.toUpperCase()}: ${s.symbol_name} ---\n`;
                if (s.signature) output += `Signature: ${s.signature}\n`;
                if (s.content) {
                    const snippet = s.content.length > 300 ? s.content.substring(0, 300) + '...' : s.content;
                    output += `Preview:\n${snippet}\n`;
                }
            }
            return { content: [{ type: "text", text: output }] };

        } else if (request.params.name === "pg_git_file_symbols") {
            const { blob_id } = args;
            const symbols = await getSymbolsForBlob(blob_id);
            if (symbols.length === 0) {
                return { content: [{ type: "text", text: `No symbols found for blob ${blob_id}.` }] };
            }

            let output = `=== 🧩 Symbols in Blob ${blob_id} ===\n`;
            for (const s of symbols) {
                output += `• L${s.start_line}-L${s.end_line} [${s.symbol_type}] ${s.symbol_name}: ${s.signature || ''}\n`;
            }
            return { content: [{ type: "text", text: output }] };

        } else if (request.params.name === "pg_git_dependency_graph") {
            const { file_path, repository_id, project } = args;

            let resolvedRepoId = repository_id;
            if (project && !resolvedRepoId) {
                const repoRes = await pool.query(`SELECT id FROM repositories WHERE name = $1`, [project]);
                if (repoRes.rows.length > 0) {
                    resolvedRepoId = repoRes.rows[0].id;
                }
            }

            if (!resolvedRepoId) {
                throw new McpError(ErrorCode.InvalidParams, "Either repository_id or valid project name is required.");
            }

            const graph = await getSymbolGraph(file_path, resolvedRepoId);
            let output = `=== 🕸️ Dependency Graph for ${file_path} ===\n\n`;

            output += `📦 Declared Symbols (${graph.symbols.length}):\n`;
            if (graph.symbols.length === 0) {
                output += `  (none)\n`;
            } else {
                for (const s of graph.symbols) {
                    output += `  • [${s.symbol_type}] ${s.symbol_name} (L${s.start_line}-L${s.end_line})\n`;
                }
            }

            output += `\n➡️ Outbound Imports (${graph.imports.length}):\n`;
            if (graph.imports.length === 0) {
                output += `  (none)\n`;
            } else {
                for (const imp of graph.imports) {
                    const syms = imp.symbols && imp.symbols.length > 0 ? ` [${imp.symbols.join(', ')}]` : '';
                    output += `  • ${imp.relation}: ${imp.target_path}${syms}\n`;
                }
            }

            output += `\n⬅️ Inbound Dependents (${graph.dependents.length}):\n`;
            if (graph.dependents.length === 0) {
                output += `  (none)\n`;
            } else {
                for (const dep of graph.dependents) {
                    const syms = dep.symbols && dep.symbols.length > 0 ? ` [${dep.symbols.join(', ')}]` : '';
                    output += `  • ${dep.source_path} (${dep.relation})${syms}\n`;
                }
            }

            return { content: [{ type: "text", text: output }] };



        } else {
            throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${request.params.name}`);
        }
    } catch (err) {
        // Re-throw MCP errors directly so the SDK handles them properly
        if (err instanceof McpError) throw err;
        return {
            content: [{ type: "text", text: `[Error] Failed executing ${request.params.name}: ${err.message}` }],
            isError: true
        };
    }
});

// ── Lifecycle ─────────────────────────────────────────────────────────────────
async function shutdown() {
    console.error('[pg-git-mcp] Shutting down...');
    try { await pool.end(); } catch (_) { /* best-effort */ }
    process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

async function main() {
    await verifyDatabase();
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("[pg-git-mcp] Server running on stdio");
}

main().catch(err => {
    console.error("[Fatal]", err);
    process.exit(1);
});
