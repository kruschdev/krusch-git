# krusch-git — Agent Context & Tool Protocol

> **Package**: `krusch-git` (v1.2.1)  
> **Role**: Git DAG, AST Chunking & Symbol Dependency Exploration Engine  
> **Transports**: Model Context Protocol (stdio) via `server/mcp.js`

---

## Project Overview

`krusch-git` is a dedicated codebase retrieval server for coding agents. It maps Git objects (blobs, trees, commits) directly into an ACID-compliant schema with AST symbol extraction (`code_symbols`) and multi-hop dependency graphs (`code_symbol_edges`).

## Available MCP Tools

When coding agents need to explore code structure, locate functions/classes, or trace caller/callee graphs, use these canonical tools:

### 1. 🌲 Symbol Navigation & Dependency Graphs
* **Search Symbols**: `krusch_git_search_symbols({ repo: "<repo_name>", query: "<symbol_name>" })`
  - Finds class, function, interface, and route declarations across the codebase.
* **Inspect Symbol Call Graph**: `krusch_git_dependency_graph({ repo: "<repo_name>", symbol: "<symbol_name>" })`
  - Returns inbound callers and outbound callees (multi-hop graph walk) to verify architectural blast radius before refactoring.
* **Inspect File Symbols**: `krusch_git_file_symbols({ repo: "<repo_name>", file_path: "<relative_path>" })`
  - Lists all AST symbols declared within a single file.

### 2. 🔍 Semantic Code Search
* **Search Code Blobs**: `krusch_git_semantic_search({ repo: "<repo_name>", query: "<search_term>" })`
  - Hybrid search combining BM25 keyword matching with pgvector cosine similarity and exponential temporal decay.

### 3. 📂 Git DAG Tree & Blob Inspection
* **List Indexed Repos**: `krusch_git_list_repos({})`
* **Read Tree Hierarchy**: `krusch_git_read_tree({ repo: "<repo_name>", tree_sha: "HEAD" })` (or `{ repository_id, tree_id }`)
* **Read Blob Content**: `krusch_git_read_blob({ repo: "<repo_name>", file_path: "<relative_path>" })` (or `{ blob_id }`)

---

## 🤖 Agent Workflow Protocol

1. **Before Modifying Complex Architecture**:
   - Use `krusch_git_search_symbols` to locate the authoritative declaration.
   - Use `krusch_git_dependency_graph` to verify all inbound callers before mutating signatures.
2. **Decision Memory vs. Code Structure**:
   - For **why** an architectural choice was made, query `krusch-context-mcp` (`krusch_context_retrieve`).
   - For **how** code is implemented and structured, query `krusch-git` (`krusch_git_search_symbols`).
