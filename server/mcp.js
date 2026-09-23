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
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECTS_ROOT = path.resolve(__dirname, '..', '..');

// Helper to resolve repository name/alias to integer ID
async function resolveRepoId(repoParam, repoIdParam) {
    if (repoIdParam !== undefined && repoIdParam !== null) {
        return Number(repoIdParam);
    }
    if (!repoParam) return null;
    const name = String(repoParam).trim();
    const repoRes = await pool.query(
        `SELECT id FROM repositories WHERE name = $1 OR name = $2 OR name = $3 LIMIT 1`,
        [name, name === 'krusch-git' ? 'pg-git' : name, name.replace(/^krusch-/, '')]
    );
    if (repoRes.rows.length > 0) {
        return repoRes.rows[0].id;
    }
    return null;
}

// ── Health Check ──────────────────────────────────────────────────────────────
async function verifyDatabase() {
    try {
        await pool.query('SELECT 1');
        console.error('[krusch-git] Database connection verified.');
    } catch (err) {
        console.error('[krusch-git] FATAL: Cannot reach PostgreSQL:', err.message);
        process.exit(1);
    }
}

// ── MCP Server ────────────────────────────────────────────────────────────────
const server = new Server(
    { name: "krusch-git", version: "1.2.1" },
    { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
        tools: [
            {
                name: "krusch_git_list_repos",
                description: "List all available repositories stored in the database.",
                inputSchema: { type: "object", properties: {} }
            },
            {
                name: "krusch_git_read_tree",
                description: "Read the directory structure (DAG node) of a specific repository. If tree_sha/tree_id is omitted or 'HEAD', reads the root tree of the main branch.",
                inputSchema: {
                    type: "object",
                    properties: {
                        repo: { type: "string", description: "Repository name (e.g. 'krusch-git', 'krusch-context-mcp')." },
                        project: { type: "string", description: "Alias for repo." },
                        repository_id: { type: "number", description: "The ID of the repository." },
                        tree_sha: { type: "string", description: "Specific SHA-1 tree hash, or 'HEAD' for root tree." },
                        tree_id: { type: "string", description: "Legacy alias for tree_sha." }
                    }
                }
            },
            {
                name: "krusch_git_read_blob",
                description: "Read the source file contents of a specific blob or file path within a repository.",
                inputSchema: {
                    type: "object",
                    properties: {
                        repo: { type: "string", description: "Repository name (e.g. 'krusch-git', 'krusch-context-mcp')." },
                        file_path: { type: "string", description: "Relative file path within repository." },
                        blob_id: { type: "string", description: "The SHA-1 hash of the blob." }
                    }
                }
            },
            {
                name: "krusch_git_semantic_search",
                description: "Search code files using Hybrid RRF (BM25 + pgvector), pure semantic vector, or keyword search. Results are decayed by age.",
                inputSchema: {
                    type: "object",
                    properties: {
                        query: { type: "string", description: "The search query." },
                        repo: { type: "string", description: "Repository name to filter search (e.g. 'krusch-git', 'krusch-context-mcp')." },
                        project: { type: "string", description: "Alias for repo." },
                        repository_id: { type: "number", description: "Optional repository ID." },
                        search_type: { 
                            type: "string", 
                            enum: ["hybrid", "semantic", "keyword"], 
                            description: "Search mode: 'hybrid' (BM25 + pgvector RRF, default), 'semantic' (pure vector), or 'keyword' (pure BM25).",
                            default: "hybrid" 
                        },
                        limit: { type: "number", description: "Number of results to return.", default: 5 }
                    },
                    required: ["query"]
                }
            },
            {
                name: "krusch_git_search_symbols",
                description: "Search for specific code symbols (functions, classes, methods, routes) across repositories with exact match boost, signatures, and line ranges.",
                inputSchema: {
                    type: "object",
                    properties: {
                        query: { type: "string", description: "Function, class, or symbol name to search for." },
                        repo: { type: "string", description: "Repository name to filter search." },
                        project: { type: "string", description: "Alias for repo." },
                        symbol_type: { type: "string", enum: ["function", "class", "method", "route", "type", "variable"], description: "Optional filter for symbol type." },
                        limit: { type: "number", description: "Max symbols to return.", default: 10 },
                        repository_id: { type: "number", description: "Optional repository ID." }
                    },
                    required: ["query"]
                }
            },
            {
                name: "krusch_git_file_symbols",
                description: "List all code symbols (functions, classes, methods, routes) declared inside a specific file or blob.",
                inputSchema: {
                    type: "object",
                    properties: {
                        repo: { type: "string", description: "Repository name." },
                        file_path: { type: "string", description: "Relative file path within repository." },
                        blob_id: { type: "string", description: "The SHA-1 hash of the blob." }
                    }
                }
            },
            {
                name: "krusch_git_dependency_graph",
                description: "Trace symbol dependencies: retrieve outbound imports, inbound callers/dependents, and declared symbols for a specific symbol or file path.",
                inputSchema: {
                    type: "object",
                    properties: {
                        symbol: { type: "string", description: "Symbol name to trace callers and dependencies for." },
                        file_path: { type: "string", description: "Relative file path (e.g., 'server/git-engine.js')." },
                        repo: { type: "string", description: "Repository name." },
                        project: { type: "string", description: "Alias for repo." },
                        repository_id: { type: "number", description: "Repository ID." }
                    }
                }
            }
        ]
    };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const rawName = request.params.name;
    const name = rawName.replace(/^pg_git_/, 'krusch_git_');
    if (rawName.startsWith('pg_git_')) {
        console.error(`[krusch-git] Notice: Tool '${rawName}' is aliased to '${name}'.`);
    }
    const args = request.params.arguments || {};

    try {
        if (name === "krusch_git_list_repos") {
            const repos = await getRepositories();
            const output = repos.map(r => `ID: ${r.id} | Name: ${r.name} | Desc: ${r.description}`).join('\n');
            return {
                content: [{ type: "text", text: output || "No repositories found." }]
            };
        } else if (name === "krusch_git_read_tree") {
            const repoParam = args.repo || args.project;
            let resolvedRepoId = args.repository_id || null;
            if (!resolvedRepoId && repoParam) {
                resolvedRepoId = await resolveRepoId(repoParam);
            }
            if (!resolvedRepoId) {
                throw new McpError(ErrorCode.InvalidParams, "Either 'repo' (name) or 'repository_id' is required.");
            }

            let targetTree = args.tree_sha || args.tree_id;
            if (!targetTree || targetTree === 'HEAD') {
                targetTree = await getRepoRootTree(resolvedRepoId);
                if (!targetTree) {
                    return { content: [{ type: "text", text: `No 'main' branch or root tree found for repository ${resolvedRepoId}. It may be empty or unindexed.` }] };
                }
            }
            
            const entries = await getTreeEntries(targetTree);
            if (!entries || entries.length === 0) {
                return { content: [{ type: "text", text: `Tree ${targetTree} is empty or does not exist.` }] };
            }
            
            const output = entries.map(e => `[${e.type.toUpperCase()}] ${e.name} (Object ID: ${e.object_id})`).join('\n');
            return { content: [{ type: "text", text: `Tree contents for ${targetTree} (repo: ${repoParam || resolvedRepoId}):\n\n${output}` }] };

        } else if (name === "krusch_git_read_blob") {
            const { blob_id, file_path, repo, project } = args;
            let blob = null;

            if (blob_id) {
                blob = await getBlob(blob_id);
            } else if (file_path) {
                const repoParam = repo || project;
                const resolvedRepoId = repoParam ? await resolveRepoId(repoParam) : null;
                const blobRes = await pool.query(`
                    SELECT b.*, r.name AS project 
                    FROM blobs b
                    JOIN repositories r ON b.repository_id = r.id
                    WHERE (b.file_path = $1 OR b.file_name = $1)
                      ${resolvedRepoId ? 'AND b.repository_id = $2' : ''}
                    ORDER BY b.last_seen_at DESC LIMIT 1
                `, resolvedRepoId ? [file_path, resolvedRepoId] : [file_path]);

                if (blobRes.rows.length > 0) {
                    blob = blobRes.rows[0];
                }
            }

            // Direct filesystem fallback if unindexed or pointer resolution needs local disk
            if (!blob && file_path && (repo || project)) {
                const projectName = repo || project;
                const candidatePaths = [
                    path.resolve(PROJECTS_ROOT, projectName, file_path),
                    path.resolve(PROJECTS_ROOT, '..', projectName, file_path)
                ];
                for (const p of candidatePaths) {
                    try {
                        const content = await fs.readFile(p, 'utf-8');
                        return { content: [{ type: "text", text: content }] };
                    } catch (_) {}
                }
            }

            if (!blob) {
                throw new McpError(ErrorCode.InvalidParams, `Blob or file '${blob_id || file_path}' not found.`);
            }
            
            const buffer = await resolveBlobContent(blob);
            if (!buffer) {
                throw new McpError(ErrorCode.InternalError, `Failed to resolve content for blob ${blob.id || file_path}.`);
            }
            const textContent = buffer.toString('utf-8');
            return { content: [{ type: "text", text: textContent }] };
            
        } else if (name === "krusch_git_semantic_search") {
            const { query: searchQuery, limit = 5, repository_id, project, repo, search_type = "hybrid" } = args;
            
            const repoParam = repo || project;
            let resolvedRepoId = repository_id || null;
            if (repoParam && !resolvedRepoId) {
                resolvedRepoId = await resolveRepoId(repoParam);
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

        } else if (name === "krusch_git_search_symbols") {
            const { query: searchQuery, limit = 10, repository_id, project, repo, symbol_type } = args;
            
            const repoParam = repo || project;
            let resolvedRepoId = repository_id || null;
            if (repoParam && !resolvedRepoId) {
                resolvedRepoId = await resolveRepoId(repoParam);
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

        } else if (name === "krusch_git_file_symbols") {
            const { blob_id, file_path, repo, project } = args;
            let symbols = [];

            if (blob_id) {
                symbols = await getSymbolsForBlob(blob_id);
            } else if (file_path) {
                const repoParam = repo || project;
                const resolvedRepoId = repoParam ? await resolveRepoId(repoParam) : null;
                const symRes = await pool.query(`
                    SELECT s.*, r.name AS project
                    FROM code_symbols s
                    JOIN repositories r ON r.id = s.repository_id
                    WHERE (s.file_path = $1 OR s.file_path ILIKE '%' || $1)
                      ${resolvedRepoId ? 'AND s.repository_id = $2' : ''}
                    ORDER BY s.start_line ASC
                `, resolvedRepoId ? [file_path, resolvedRepoId] : [file_path]);
                symbols = symRes.rows;
            }

            if (symbols.length === 0) {
                return { content: [{ type: "text", text: `No symbols found for ${blob_id || file_path || 'file'}.` }] };
            }

            let output = `=== 🧩 Symbols in ${file_path || blob_id} ===\n`;
            for (const s of symbols) {
                output += `• L${s.start_line}-L${s.end_line} [${s.symbol_type}] ${s.symbol_name}: ${s.signature || ''}\n`;
            }
            return { content: [{ type: "text", text: output }] };

        } else if (name === "krusch_git_dependency_graph") {
            const { file_path, symbol, repository_id, project, repo } = args;

            const repoParam = repo || project;
            let resolvedRepoId = repository_id || null;
            if (repoParam && !resolvedRepoId) {
                resolvedRepoId = await resolveRepoId(repoParam);
            }

            let targetFilePath = file_path;
            let targetSymbol = symbol;

            // If symbol is passed without file_path, look up the authoritative file declaration
            if (!targetFilePath && targetSymbol) {
                const symRes = await pool.query(
                    `SELECT file_path, repository_id FROM code_symbols 
                     WHERE symbol_name = $1 ${resolvedRepoId ? 'AND repository_id = $2' : ''} 
                     ORDER BY id ASC LIMIT 1`,
                    resolvedRepoId ? [targetSymbol, resolvedRepoId] : [targetSymbol]
                );
                if (symRes.rows.length > 0) {
                    targetFilePath = symRes.rows[0].file_path;
                    if (!resolvedRepoId) resolvedRepoId = symRes.rows[0].repository_id;
                } else {
                    return { content: [{ type: "text", text: `Symbol '${targetSymbol}' not found in indexed repositories.` }] };
                }
            }

            if (!targetFilePath) {
                throw new McpError(ErrorCode.InvalidParams, "Either 'symbol' or 'file_path' is required.");
            }

            if (!resolvedRepoId) {
                const repoFind = await pool.query(
                    `SELECT repository_id FROM code_symbols WHERE file_path = $1 LIMIT 1`,
                    [targetFilePath]
                );
                if (repoFind.rows.length > 0) {
                    resolvedRepoId = repoFind.rows[0].repository_id;
                } else {
                    throw new McpError(ErrorCode.InvalidParams, "Either repository_id or valid repo/project name is required.");
                }
            }

            const graph = await getSymbolGraph(targetFilePath, resolvedRepoId);
            let output = `=== 🕸️ Dependency Graph for ${targetFilePath}${targetSymbol ? ` (focus: ${targetSymbol})` : ''} ===\n\n`;

            if (targetSymbol) {
                const matching = graph.symbols.filter(s => s.symbol_name === targetSymbol);
                if (matching.length > 0) {
                    output += `🎯 Target Symbol Definition:\n`;
                    for (const m of matching) {
                        output += `  • [${m.symbol_type.toUpperCase()}] ${m.symbol_name} (L${m.start_line}-L${m.end_line})${m.signature ? ` | ${m.signature}` : ''}\n`;
                    }
                    output += '\n';
                }
            }

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
            throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${rawName}`);
        }
    } catch (err) {
        if (err instanceof McpError) throw err;
        return {
            content: [{ type: "text", text: `[Error] Failed executing ${rawName}: ${err.message}` }],
            isError: true
        };
    }
});

// ── Lifecycle ─────────────────────────────────────────────────────────────────
async function shutdown() {
    console.error('[krusch-git] Shutting down...');
    try { await pool.end(); } catch (_) { /* best-effort */ }
    process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

async function main() {
    await verifyDatabase();
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("[krusch-git] Server running on stdio");
}

const isDirectRun = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isDirectRun) {
    main().catch(err => {
        console.error("[Fatal]", err);
        process.exit(1);
    });
}

export { server, verifyDatabase };
