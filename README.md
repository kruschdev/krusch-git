# Krusch-Git (Codebase & Git AST Memory Engine)

A persistent Git DAG indexer, AST chunker, and semantic codebase retrieval engine for AI coding agents. Stores the entire Directed Acyclic Graph (DAG) natively, extracting code symbols, call edges, and chunked semantic vector embeddings. Compatible with both local SQLite and PostgreSQL.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
![Node](https://img.shields.io/badge/Node.js-22+-green.svg)
![Storage](https://img.shields.io/badge/Storage-SQLite%20%2F%20PostgreSQL-lightgrey.svg)

## 🧠 Why Krusch-Git?

In the standard AI coding agent ecosystem, searching codebases relies on rigid grep searches or expensive ad-hoc AST parsing. Krusch-Git fundamentally changes this by bridging Git directly with persistent semantic graphs:
1. **Semantic Code Search**: Find code based on what it *does*, not just exact token syntax.
2. **AST Symbol & Edge Graph**: Walks call graphs, definitions, and symbol dependencies across your repository.
3. **Exponential Temporal Decay**: Mathematically decays older vectors. Your agent prioritizes code written recently over stale or dead code.
4. **Decoupled Architecture**: Sits as an independent MCP server alongside [krusch-context-mcp](https://github.com/kruschdev/krusch-context-mcp).

## ⚠️ Not a Replacement for Git

It is critical to understand that PG-Git **does not replace Git** or services like GitHub/GitLab. It does not handle branch merging, rebasing, or pull requests. 

Instead, PG-Git is an **agentic augmentation layer**. You continue to use standard Git for your human-facing source control and team collaboration. PG-Git sits alongside it in your workflow, automatically ingesting your standard Git history to provide your AI agents with a mathematically optimized, semantically searchable clone of your codebase.

## 🔒 Reliability Audit & Pointer Resolution

To guarantee production-grade stability and complete continuity across complex monorepos, PG-Git underwent a thorough architectural audit and reliability overhaul:

1. **Deterministic Pointer Resolution**: In standard `'pointer'` storage mode (used to keep the database lightweight), file content is stored as `NULL` in PostgreSQL. We introduced a dynamic resolver inside `server/git-engine.js` that maps relative blob paths to the local filesystem monorepo root. This automatically streams raw file contents from disk on demand, resolving previous `null` value crashes on the Express `/api/blobs/:id` route and `pg_git_read_blob` MCP tool.
2. **Safe Semantic Search Previews**: Standard semantic search tool calls throw TypeErrors if they attempt to stringify nullable database columns. PG-Git now safely extracts the pre-compiled `summary` column (generated using `qwen2.5-coder:14b` inline summaries) to serve as the context preview.
3. **Starvation-Proof Queue Management**: The fleet priority queue (`PriorityQueue.process`) inside `lib/llm-queue.js` is secured using a strict `try ... finally` block. This guarantees that concurrent slots are cleanly released (`this.active--`) under all task outcomes, preventing memory and slot leaks that would otherwise block multi-agent swarm operations.
4. **Fidelity-Preserved Embedding Backfills**: Upgraded `backfill_embeddings.js` to automatically resolve local disk paths when processing pointer-mode blobs. This enables the embedding backfill process to compute full-fidelity, chunked centroid embeddings from the original code rather than falling back to lossy, shortened summary snippets.

## 🤝 Sibling Synergy with Krusch Context MCP

PG-Git serves two distinct, first-class deployment models:
1. **Standalone Codebase RAG Engine (`pg-git-mcp@1.1.0`)**: An independent, lightweight MCP server providing Git DAG indexing, hybrid RRF search, and AST symbol extraction for developers who only want codebase search in their IDE or custom agent pipelines.
2. **Shared Substrate with [Krusch Context MCP](https://github.com/kruschdev/krusch-context-mcp)**: Krusch Context MCP incorporates the native consolidated codebase engine while sharing the exact same PostgreSQL schema (`repositories`, `blobs`, `code_symbols`, `code_symbol_edges`, `trees`, `commits`, `branches`).

| Layer | Source Table | Purpose |
|-------|--------------|---------|
| **Codebase Memory (The "What" & "How")** | `blobs`, `code_symbols`, `code_symbol_edges` | Semantically embedded source files, AST symbols, and dependency edges |
| **Episodic Memory (The "Why")** | `ide_agent_memory`, `interaction_memory` | Architectural decisions, bugs encountered, project goals |
| **Holographic Nuggets (The "How to Behave")** | `ide_agent_nuggets` | Lightweight steering facts, user preferences, project conventions |

**Infinite Continuity**: When using Krusch Context MCP, your agent cross-references the *intent* (episodic memory) with the *implementation* (codebase blobs and AST symbols). It remembers *why* you chose a specific architecture, and instantly sees *how* it's currently implemented, creating a deeply contextualized and autonomous coding workflow that persists across infinite sessions.

> 🔗 **See the full unified server documentation:** [Krusch Context MCP README](https://github.com/kruschdev/krusch-context-mcp)

## ⚡ Quick Start

You **must** have [Ollama](https://ollama.com/) running with the `bge-large` embedding model pulled:
```bash
ollama pull bge-large
```

**1. Clone & Migrate Database**
You will need a running PostgreSQL instance with `pgvector` enabled.
```bash
git clone https://github.com/kruschdev/pg-git.git
cd pg-git
npm install
cp .env.example .env
# Edit .env with your PostgreSQL credentials
node db/migrate.js
```

**2. Import Your GitHub History**

> [!WARNING]
> **Choose your embedding model carefully.** You must set your preferred model (via the Web UI Settings tab or `.env`) *before* running your first import or snapshot. If you change models later, vector dimensions will collide and you will be forced to manually wipe the database and re-embed all repositories from scratch.

You can instantly import any local `.git` repository. PG-Git will natively parse the Git history, generate semantic embeddings for all blobs, and securely deduplicate them into PostgreSQL:
```bash
npm run import
```

**3a. Use via Krusch Context MCP (Recommended)**

The recommended way to use PG-Git across the homelab fleet is through the flagship [Krusch Context MCP](https://github.com/kruschdev/krusch-context-mcp) unified server, which natively incorporates PG-Git's Git DAG, AST symbol parsing, dependency graph traversal, and hybrid RRF search into a 59-tool unified working memory server alongside episodic memory, steering facts, and AI Watch research engines. See the [Krusch Context MCP Quick Start](https://github.com/kruschdev/krusch-context-mcp#-quick-start) for setup instructions.

**3b. Use Standalone MCP Server**

If you prefer to run PG-Git as an isolated MCP server, you can execute it directly via NPM. Add it to your agent/IDE configuration (e.g., `mcp_config.json`):
```json
{
  "mcpServers": {
    "pg-git-mcp": {
      "command": "npx",
      "args": ["-y", "pg-git-mcp"],
      "env": {
        "PG_CONNECTION_STRING": "postgres://user:pass@localhost:5434/kruschdb",
        "OLLAMA_URL": "http://localhost:11434",
        "EMBED_MODEL": "bge-large"
      }
    }
  }
}
```

**4. Start the Web UI (Optional)**
PG-Git includes a sleek, dual-pane IDE interface for browsing your semantic repositories.
```bash
npm run dev
```

---

## 🔧 MCP Tools (Standalone Mode)

When running PG-Git as a standalone MCP server (`server/mcp.js`), it exposes 7 specialized tools:

| Tool | Description |
|------|-------------|
| `pg_git_list_repos` | List all available Git repositories indexed in PostgreSQL |
| `pg_git_read_tree` | Browse repository file tree and directory entries |
| `pg_git_read_blob` | Read full source file content by blob SHA |
| `pg_git_semantic_search` | Hybrid RRF search (dense cosine + BM25 full-text) with temporal decay (`search_type: 'hybrid' \| 'semantic' \| 'keyword'`) |
| `pg_git_search_symbols` | Search extracted AST code symbols (functions, classes, methods, routes) across repositories |
| `pg_git_file_symbols` | Get all AST symbols declared in a specific file or blob |
| `pg_git_dependency_graph` | Trace inbound callers, outbound imports, and dependencies up to $N$ hops |

> [!NOTE]
> When using **Krusch Context MCP**, all these capabilities are natively consolidated under unified tool names (`krusch_context_search_code`, `krusch_context_search_symbols`, `krusch_context_symbol_graph`, `krusch_context_read_tree`, `krusch_context_read_blob`, `krusch_context_list_repos`) alongside 50+ memory, nugget, and AI research tools. Both servers support the same `pg_git_*` aliases for universal compatibility.

---

## 🚀 Real-World Usage Examples

### Standalone Mode

Speak to your IDE agent normally. It will use the standalone MCP tools to interface with the database:

**Example 1: Finding specific logic**
> **You:** "Where do we handle the temporal decay for the memory MCP?"
> **Agent:** *[Calls `pg_git_semantic_search`]* "I found the logic in `server/git-engine.js`. It uses the `exp(-0.01 * age_in_days)` formula in `searchBlobs()`."

**Example 2: Reading a repository tree**
> **You:** "What is the folder structure for the pg-git project?"
> **Agent:** *[Calls `pg_git_read_tree`]* "Here is the root directory structure..."

**Example 3: Filtering by project**
> **You:** "Search for authentication logic in the pocket-lawyer project only."
> **Agent:** *[Calls `pg_git_semantic_search` with `project: 'pocket-lawyer'`]* "Found 3 matches in the auth module..."

### How Does Temporal Decay Work?

When calling `pg_git_semantic_search`, PG-Git returns the highest cosine-similarity matches. However, it applies **Exponential Temporal Decay** based on the blob's `last_seen_at` timestamp:

```
score = cosine_similarity × exp(-0.01 × age_in_days)
```

If you have two very similar pieces of code, the *newer* one will have a significantly higher score, preventing your agent from hallucinating based on outdated implementations.

---

## 🤖 The Autonomous Agent Workflow

You can integrate PG-Git into your agentic workflow to ensure your semantic memory is always up to date. 

### Snapshot (Single Project)
Whenever you step away from a task, tell your agent to run the snapshot script. The agent will autonomously:
1. Hash the current project folder into Git Blobs and Trees.
2. Ping Ollama to embed any new or modified files.
3. Commit the state directly into PostgreSQL.

```bash
npm run snapshot
```

### Sync All Projects (Fleet-Wide)
To re-index all active project codebases across the fleet:

```bash
npm run sync-all
```

### External Documentation Sync
PG-Git can ingest external documentation (e.g., `llms.txt` manifests) for hallucination-free framework knowledge:

```bash
node scripts/sync_external_docs.js
```

---

## 📂 Project Structure

```
pg-git/
├── server/
│   ├── index.js              # Express API + Web UI server
│   ├── mcp.js                # Standalone MCP server (StdioServerTransport)
│   └── git-engine.js         # Git DAG operations + semantic search with temporal decay
├── db/
│   ├── schema.sql            # PostgreSQL schema (repos, commits, branches, trees, blobs + pgvector)
│   ├── pool.js               # Shared pg.Pool connection
│   ├── migrate.js            # Schema migration runner
│   ├── create-db.js          # Database creation helper
│   └── list-dbs.js           # List available databases
├── lib/
│   └── embedding.js          # Shared Ollama embedding client with fleet load balancing
├── scripts/
│   ├── sync_to_pg.js         # Snapshot a single project into PostgreSQL
│   ├── sync_all_projects.js  # Fleet-wide project sync
│   ├── sync_external_docs.js # External documentation ingestion (llms.txt)
│   ├── import_github.js      # Import native .git history
│   ├── import_hf_dataset.js  # Import HuggingFace datasets
│   ├── backfill_embeddings.js # Backfill missing embeddings
│   ├── migrate_to_1024.js    # Dimension migration helper
│   ├── migrate_to_pointer.js # Storage mode migration
│   └── scaffold_nesting_dolls.js # Nesting-doll chunking scaffold
├── client/                   # Vite + React Web UI
├── config/
│   └── external_docs.json    # External documentation manifest
├── config.js                 # Unified configuration (env + config.json merge)
├── assets/                   # Banner and social preview images
├── Dockerfile                # Multi-stage production build
├── docker-compose.yml        # Container orchestration
├── AGENTS.md                 # Agent context rules for AI IDEs
└── spec.md                   # Original project specification
```

---

## 🛠️ Configuration & Environment Variables

PG-Git uses a layered configuration system: environment variables override `config.json`, which overrides built-in defaults.

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | Express server port | `4890` |
| `DB_HOST` | PostgreSQL Host address | `localhost` |
| `DB_PORT` | PostgreSQL Port | `5434` |
| `DB_NAME` | Database Name | `postgres` |
| `DB_USER` | Database User | `postgres` |
| `DB_PASSWORD` | Database Password | *(empty)* |
| `OLLAMA_URL` | The endpoint for your local Ollama instance | `http://localhost:11434` |
| `EMBED_MODEL`| The Ollama text-embedding model to use | `bge-large` |

### Database Schema (v1.1.0)

PG-Git's PostgreSQL schema maps Git objects and code structure directly into SQL tables:

- **`repositories`** — Project registries
- **`commits`** — SHA-1 identified commit objects with tree and parent references
- **`branches`** — Named references to commit heads
- **`trees`** / **`tree_entries`** — Directory structures mapping names to blob/tree object IDs
- **`blobs`** — File content with `embedding vector(1024)`, `tsv tsvector` (simple full-text BM25 index), and `last_seen_at` temporal tracking
- **`code_symbols`** — Structural AST-extracted functions, classes, methods, and routes with signatures and exact `start_line`/`end_line` ranges
- **`code_symbol_edges`** — Relational dependency graph tracking outbound `imports` and inbound callers/dependents across files

### MCP Tools Reference (v1.1.0)

When running PG-Git as an MCP server (`npx pg-git-mcp` or `node server/mcp.js`), the following 7 tools are available:

| Tool Name | Parameters | Description |
|---|---|---|
| `pg_git_list_repos` | *(none)* | List all available PG-Git repositories stored in PostgreSQL |
| `pg_git_read_tree` | `repository_id`, `tree_id?` | Read directory structure (DAG node) of a repo |
| `pg_git_read_blob` | `blob_id` | Read file contents of a specific blob |
| `pg_git_semantic_search` | `query`, `search_type?`, `limit?`, `project?`, `repository_id?` | Hybrid RRF (BM25 + pgvector), pure semantic, or keyword search with temporal decay |
| `pg_git_search_symbols` | `query`, `symbol_type?`, `limit?`, `project?`, `repository_id?` | Search for functions, classes, methods, or routes with signatures and line ranges |
| `pg_git_file_symbols` | `blob_id` | List all code symbols declared inside a specific file blob |
| `pg_git_dependency_graph` | `file_path`, `repository_id?`, `project?` | Trace outbound imports, inbound dependents, and declared symbols for a file |

### 🔬 Research Foundations (2026 Code-RAG)
- **GRASP (arXiv: 2607.10463)**: Granularity-aware retrieval across symbol definitions and whole-file trees.
- **Reciprocal Rank Fusion (RRF)**: $RRF(d) = \frac{1}{60 + r_{\text{dense}}} + \frac{1}{60 + r_{\text{bm25}}}$, fused with exponential temporal decay $\exp(-0.01 \times age_{\text{days}})$.
- **CodexGraph & CocoIndex**: Structural graph navigation linking call sites, imports, and AST declarations.


---

## 🗺️ Related Projects

| Project | Role |
|---------|------|
| **[Krusch Context MCP](https://github.com/kruschdev/krusch-context-mcp)** | Unified IDE context server — wraps PG-Git + episodic memory + nuggets into a single MCP process |
| [PG-Git MCP on NPM](https://www.npmjs.com/package/pg-git-mcp) | This project published to the NPM registry |
| [NeoVertex Nuggets](https://github.com/NeoVertex1/nuggets) | Original Holographic Nuggets MCP architecture adapted in Krusch Context |

## License
ISC License. Created by [kruschdev](https://github.com/kruschdev).
