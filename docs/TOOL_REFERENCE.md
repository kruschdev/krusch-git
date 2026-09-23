# Krusch-Git MCP Tool Reference (v1.2.0)

> Authoritative specification for all Model Context Protocol (MCP) tools provided by `krusch-git`.

The server exposes **7 canonical tools** over `StdioServerTransport` (`server/mcp.js`). Legacy `pg_git_*` tool calls are automatically aliased for backward compatibility.

---

## 1. `krusch_git_list_repos`

List all available Git repositories indexed in PostgreSQL.

* **Alias**: `pg_git_list_repos`
* **Input Schema**:
  ```json
  {
    "type": "object",
    "properties": {}
  }
  ```
* **Output**:
  ```json
  [
    {
      "id": 1,
      "name": "krusch-context-mcp",
      "path": "/home/krusch/homelab/projects/krusch-context-mcp",
      "head_commit": "0c7ec1f",
      "last_indexed_at": "2026-09-23T22:43:55.000Z"
    }
  ]
  ```

---

## 2. `krusch_git_read_tree`

Read the directory structure (DAG node) of a specific repository.

* **Alias**: `pg_git_read_tree`
* **Input Schema**:
  ```json
  {
    "type": "object",
    "properties": {
      "repository_id": { "type": "number", "description": "The ID of the repository." },
      "tree_id": { "type": "string", "description": "Specific SHA-1 tree hash. Omit for root tree." }
    },
    "required": ["repository_id"]
  }
  ```

---

## 3. `krusch_git_read_blob`

Read source file contents for a specific Git blob. Handles pointer-mode resolution from disk automatically.

* **Alias**: `pg_git_read_blob`
* **Input Schema**:
  ```json
  {
    "type": "object",
    "properties": {
      "blob_id": { "type": "number", "description": "The ID of the blob." }
    },
    "required": ["blob_id"]
  }
  ```

---

## 4. `krusch_git_semantic_search`

Hybrid RRF (Reciprocal Rank Fusion) search across code blobs combining dense `pgvector` cosine similarity with full-text BM25 keyword matching, weighted by exponential temporal decay.

* **Alias**: `pg_git_semantic_search`
* **Mathematical Scoring**:
  $$RRF(d) = \frac{1}{60 + r_{\text{dense}}} + \frac{1}{60 + r_{\text{bm25}}}$$
  $$\text{FinalScore} = \text{Score} \times e^{-0.01 \times \text{age\_in\_days}}$$
* **Input Schema**:
  ```json
  {
    "type": "object",
    "properties": {
      "query": { "type": "string", "description": "Natural language or code query." },
      "search_type": { "type": "string", "enum": ["hybrid", "semantic", "keyword"], "default": "hybrid" },
      "limit": { "type": "number", "default": 5 },
      "project": { "type": "string", "description": "Filter by repository/project name." },
      "repository_id": { "type": "number", "description": "Filter by repository ID." }
    },
    "required": ["query"]
  }
  ```

---

## 5. `krusch_git_search_symbols`

Search extracted AST code symbols (functions, classes, methods, routes) across repositories.

* **Alias**: `pg_git_search_symbols`
* **Input Schema**:
  ```json
  {
    "type": "object",
    "properties": {
      "query": { "type": "string", "description": "Symbol name or pattern to locate." },
      "symbol_type": { "type": "string", "enum": ["function", "class", "method", "route", "all"], "default": "all" },
      "limit": { "type": "number", "default": 10 },
      "project": { "type": "string", "description": "Filter by project name." },
      "repository_id": { "type": "number", "description": "Filter by repository ID." }
    },
    "required": ["query"]
  }
  ```

---

## 6. `krusch_git_file_symbols`

List all AST symbols declared inside a specific file blob.

* **Alias**: `pg_git_file_symbols`
* **Input Schema**:
  ```json
  {
    "type": "object",
    "properties": {
      "blob_id": { "type": "number", "description": "The blob ID to inspect." }
    },
    "required": ["blob_id"]
  }
  ```

---

## 7. `krusch_git_dependency_graph`

Inspect the caller/callee dependency graph for a file or symbol to verify blast radius before refactoring.

* **Alias**: `pg_git_dependency_graph`
* **Input Schema**:
  ```json
  {
    "type": "object",
    "properties": {
      "file_path": { "type": "string", "description": "File path to trace dependencies for." },
      "repository_id": { "type": "number", "description": "Repository ID." },
      "project": { "type": "string", "description": "Project name." }
    },
    "required": ["file_path"]
  }
  ```
