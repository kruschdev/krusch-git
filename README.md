# Krusch-Git (Codebase & Git AST Memory Engine)

A persistent Git DAG indexer, AST chunker, and semantic codebase retrieval engine for AI coding agents. Stores the entire Directed Acyclic Graph (DAG) natively in PostgreSQL with pgvector, extracting code symbols, call edges, and chunked semantic vector embeddings.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
![Node](https://img.shields.io/badge/Node.js-22+-green.svg)
![Storage](https://img.shields.io/badge/Storage-PostgreSQL%20%2B%20pgvector-lightgrey.svg)
[![Article: Architecture Deep Dive](https://img.shields.io/badge/Article-Architecture%20Deep%20Dive-cyan.svg)](https://krusch.dev/articles/krusch-git-architecture.html)
[![Docs: What Makes It Special](https://img.shields.io/badge/Docs-What%20Makes%20It%20Special-purple.svg)](docs/WHAT_MAKES_IT_SPECIAL.md)
[![HOL Guard Catalog](https://img.shields.io/badge/HOL_Guard-Catalog_Listed-0B0F17?logo=shield&logoColor=00F5D4)](https://hol.org/guard/extension-studio?extension=mcp.krusch-git)
[![M8ven Score](https://m8ven.ai/badge/mcp/kruschdev/krusch-git)](https://m8ven.ai/mcp/kruschdev/krusch-git?s=readme)

> 📖 **Read the Systems Deep Dive**: Check out the published architecture essay [**krusch-git: Git DAG Indexing, Relational AST Symbols, and Hybrid Recency Search for AI Coding Agents**](https://krusch.dev/articles/krusch-git-architecture.html) on krusch.dev, or the local companion guide in [`docs/WHAT_MAKES_IT_SPECIAL.md`](docs/WHAT_MAKES_IT_SPECIAL.md).

## 🧠 Why Krusch-Git?

In the standard AI coding agent ecosystem, searching codebases relies on rigid grep searches or expensive ad-hoc AST parsing. Krusch-Git fundamentally changes this by bridging Git directly with persistent semantic graphs:
1. **Semantic Code Search**: Find code based on what it *does*, not just exact token syntax.
2. **AST Symbol & Edge Graph**: Walks call graphs, definitions, and symbol dependencies across your repository.
3. **Exponential Temporal Decay**: Mathematically decays older vectors. Your agent prioritizes code written recently over stale or dead code.
4. **Decoupled Architecture**: Sits as an independent MCP server alongside [krusch-context-mcp](https://github.com/kruschdev/krusch-context-mcp).

## ⚠️ Not a Replacement for Git

It is critical to understand that Krusch-Git **does not replace Git** or services like GitHub/GitLab. It does not handle branch merging, rebasing, or pull requests. 

Instead, Krusch-Git is an **agentic augmentation layer**. You continue to use standard Git for your human-facing source control and team collaboration. Krusch-Git sits alongside it in your workflow, automatically ingesting your standard Git history to provide your AI agents with a mathematically optimized, semantically searchable clone of your codebase.

## 🔒 Reliability Audit & Pointer Resolution

To guarantee production-grade stability and complete continuity across complex monorepos, Krusch-Git underwent a thorough architectural audit and reliability overhaul:

1. **Deterministic Pointer Resolution**: In standard `'pointer'` storage mode (used to keep the database lightweight), file content is stored as `NULL` in PostgreSQL. We introduced a dynamic resolver inside `server/git-engine.js` that maps relative blob paths to the local filesystem monorepo root. This automatically streams raw file contents from disk on demand, resolving previous `null` value crashes on the Express `/api/blobs/:id` route and `krusch_git_read_blob` MCP tool.
2. **Safe Semantic Search Previews**: Standard semantic search tool calls throw TypeErrors if they attempt to stringify nullable database columns. Krusch-Git now safely extracts the pre-compiled `summary` column (generated using `qwen2.5-coder:7b` inline summaries) to serve as the context preview.
3. **Starvation-Proof Queue Management**: The fleet priority queue (`PriorityQueue.process`) inside `lib/llm-queue.js` is secured using a strict `try ... finally` block. This guarantees that concurrent slots are cleanly released (`this.active--`) under all task outcomes, preventing memory and slot leaks that would otherwise block multi-agent swarm operations.
4. **Fidelity-Preserved Embedding Backfills**: Upgraded `backfill_embeddings.js` to automatically resolve local disk paths when processing pointer-mode blobs. This enables the embedding backfill process to compute full-fidelity, chunked centroid embeddings from the original code rather than falling back to lossy, shortened summary snippets.
5. **Pointer-Slimmed Symbol Indexing & On-Demand Snippet Hydration (`v1.2.2`)**: Instead of duplicating up to 3,000 characters of raw code inside `code_symbols.content`, `sync_to_pg.js` stores a compact `[POINTER_TOKENS]` identifier stream so PostgreSQL's generated `tsv` full-text index remains 100% lossless while cutting symbol storage overhead by >85%. When `krusch_git_search_symbols` returns top hits, `resolveSymbolSnippet()` dynamically slices `start_line..end_line` directly from disk via `resolveBlobContent()`.
6. **Per-Symbol SHA-256 Hash (`symbol_hash`) & Markdown Heading Spine (`symbol_type = 'section'`)**: Every extracted symbol and Markdown heading section (`#`, `##`, `###`) computes a normalized SHA-256 `symbol_hash` (`lib/ast-chunker.js`) and extracts relative Markdown link edges (`edgeType = 'references'`), enabling structural section retrieval across `README.md`, `AGENTS.md`, and `docs/*.md` alongside code AST symbols.
7. **Polyglot Java AST & Live Cursor Import Activity (`v1.2.3`)**: `lib/ast-chunker.js` extracts Java `class`, `interface`, `@interface`, `enum`, `record`, constructor/method bodies, `;`-terminated interface signatures, and `static` imports (`parseJava`), paired with `analyzeImportSymbolActivity()` to classify imported bindings (`immediate_cursor`, `unused_staged`, `earlier_only`) with 1-hop typed/constructed local and field receiver tracking.

## 📊 Empirical Benchmark: RepoBench-R (`n = 47,998` Cross-File Queries)

Evaluated hermetically across **100% of the official `tianyang/repobench-r` v1.1 test suite** (`47,998` Python & Java cross-file retrieval queries across all 8 `cff`/`cfr` × `easy`/`hard` splits; zero LLM judge, runtime `Proxy` oracle traps, and SHA-256 provenance audit) with `snowflake-arctic-embed2` (`1,024d`):

| Scope / Split | Import Order | Identifier BM25 | Pure Dense (`snowflake-arctic-embed2`) | **`krusch-git v1.2.3` (Hybrid RRF + AST + Import Activity)** | Lift vs. Pure Dense |
| :--- | :---: | :---: | :---: | :---: | :---: |
| **Official 8-Split Macro (`Acc@1` / `Acc@5` / `MRR`)** | `11.84%` / `57.01%` / `0.3109` | `15.98%` / `63.95%` / `0.3598` | `15.69%` / `64.14%` / `0.3586` | **`19.12%` / `68.58%` / `0.3957`** | **`+21.8%` `Acc@1` (`+61.5%` vs. Import Order)** |
| **Python 4-Split Macro (`n = 23,998`)** | `12.33%` / `56.78%` / `0.3133` | `18.53%` / `66.03%` / `0.3836` | `17.82%` / `66.41%` / `0.3790` | **`21.67%` / `70.07%` / `0.4179`** | **`+21.6%` `Acc@1`** |
| **Java 4-Split Macro (`n = 24,000`)** | `11.35%` / `57.23%` / `0.3084` | `13.44%` / `61.88%` / `0.3359` | `13.57%` / `61.88%` / `0.3381` | **`16.57%` / `67.09%` / `0.3735`** | **`+22.1%` `Acc@1`** |
| **Cross-File Random (`cfr`) Easy `Acc@1` (Py / Java)** | `12.71%` / `11.67%` | `25.83%` / `19.65%` | `21.75%` / `19.85%` | **`31.33%` / `27.45%`** | **Surpasses published `CodeBERT` (`~20.6%`/`~19.3%`) & `UniXcoder` (`~28.8%`/`~26.9%`) on both Py & Java** |

## 📊 Empirical Benchmark: ACL 2025 `CoIR` (`10 / 10` Tasks — `2,389,123` Docs & `162,216` Queries)

Evaluated hermetically across **100% of all `10 / 10` official ACL 2025 `CoIR` code retrieval tasks** (`20 / 20` unshrunk sub-corpora: `cosqa`, `codetrans-dl`, `codetrans-contest`, `apps`, `stackoverflow-qa`, `synthetic-text2sql`, `codefeedback-st`, `codefeedback-mt`, 6-language `codesearchnet`, and 6-language `codesearchnet-ccr`; `0` LLM judges, runtime `Proxy` oracle traps, and SHA-256 provenance audit archived at [`krush420/sovereign-g4-benchmarks`](https://huggingface.co/datasets/krush420/sovereign-g4-benchmarks)) with local-weights `snowflake-arctic-embed2:latest` (`568M` params, `1,024d`, `8,192` ctx):

| Aggregation / Highlight Task | Porter `FTS5` BM25 (`NDCG@10` / `R@10`) | Pure Dense (`snowflake-arctic-embed2`) | **`krusch-git` (Hybrid RRF + AST Spine + Subtoken `FTS5`)** | Comparison vs. ACL 2025 `CoIR` Table 3 (`Li et al.`) |
| :--- | :---: | :---: | :---: | :--- |
| **Official 10-Task Macro Average (`NDCG@10` / `MRR@10` / `R@10`)** | `48.98%` / `44.06%` / `64.85%` | `55.65%` / `50.64%` / `71.71%` | **`56.40%` / `50.94%` / `73.88%`** | **`#1` Overall (`+0.75 pp` `NDCG@10` & `+2.17 pp` `R@10` vs. Dense)** — exceeds all `10` Table 3 models incl. `Voyage-Code-002` (`56.26%`) & `E5-Mistral 7B` (`55.18%`)* |
| **`CodeSearchNet` (`6` Langs, `1,003,765` Docs / `52,561` Qs)** | `41.81%` / `52.77%` | `57.72%` / `70.07%` | **`59.76%` / `72.80%`** | **`+5.51 pp`** over `E5-Mistral 7B` (`54.25%`); Python AST Spine hits **`81.45%` `NDCG@10`** |
| **`CodeFeedback-MT` (`66,383` Docs / `13,277` Multi-Turn Qs)** | `54.53%` / `63.27%` | `52.23%` / `64.86%` | **`60.23%` / `70.81%`** | **`+8.00 pp`** over Pure Dense & **`+18.24 pp`** over Table 3 best (`41.99%`; `51.32%` `GTE 4k` Table 5) |
| **`CodeFeedback-ST` (`156,526` Docs / `31,306` Qs)** | `62.58%` / `76.45%` | `72.81%` / `89.11%` | **`74.76%` / `90.26%`** | **`#1`** vs. Table 3 best (`E5-base` `74.52%`, `E5-Mistral 7B` `72.71%`) |
| **`Synthetic-Text2SQL` (`105,851` Docs / `5,851` Qs)** | `40.74%` / `70.91%` | `44.49%` / `77.75%` | **`48.71%` / `84.19%`** | **`+4.22 pp` `NDCG@10` & `+6.44 pp` `Recall@10`** over Pure Dense via identifier/SQL hybrid fusion |

*\*Scope Note: ACL 2025 `CoIR` Table 3 truncated inputs at `512` tokens, whereas `snowflake-arctic-embed2:latest` operates at its native `8,192`-token context window.*

## 🤝 Sibling Synergy with Krusch Context MCP

Krusch-Git and [krusch-context-mcp](https://github.com/kruschdev/krusch-context-mcp) form a complementary two-server architecture for AI coding agents:

| Server | Responsibility | Verbs / Tools |
|---|---|---|
| **[krusch-context-mcp](https://github.com/kruschdev/krusch-context-mcp)** | Project memory, episodic decisions, steering invariants | 5 core verbs (`retrieve`, `remember`, `revise`, `nudge`, `health`) |
| **[krusch-git](https://github.com/kruschdev/krusch-git)** | Codebase AST, symbol search, Git DAG indexing | 7 tools (`krusch_git_search_symbols`, `krusch_git_semantic_search`, ...) |

**Separation of Concerns**: Memory and codebase indexing are decoupled. Your agent uses `krusch-context-mcp` to know *why* architectural decisions were made and *what* rules to follow, and queries `krusch-git` to find *where* code lives, how symbols connect, and what the Git history looks like.

## ⚡ Quick Start

You **must** have [Ollama](https://ollama.com/) running with a `1024`-dimensional embedding model pulled (default: `snowflake-arctic-embed2`, `8,192`-token context; also supports `qwen3-embedding` MRL `1024d` or `bge-large`):
```bash
ollama pull snowflake-arctic-embed2
```

**1. Clone & Migrate Database**
You will need a running PostgreSQL instance with `pgvector` enabled.
```bash
git clone https://github.com/kruschdev/krusch-git.git
cd krusch-git
npm install
cp .env.example .env
# Edit .env with your PostgreSQL credentials
node db/migrate.js
```

**2. Import Your GitHub History**

> [!WARNING]
> **Choose your embedding model carefully.** Set your preferred `1024`-dim model (via the Web UI Settings tab or `EMBED_MODEL` in `.env`) *before* running your first import or snapshot. Mixing incompatible vector spaces without re-embedding will degrade semantic search recall.

You can instantly import any local `.git` repository. Krusch-Git will natively parse the Git history, generate semantic embeddings for all blobs and AST symbols, and securely deduplicate them into PostgreSQL:
```bash
npm run import
```

**3. Configure in Your Agent / IDE**

Add Krusch-Git to your agent/IDE configuration (e.g., `mcp_config.json`):
```json
{
  "mcpServers": {
    "krusch-git": {
      "command": "npx",
      "args": ["-y", "krusch-git"],
      "env": {
        "DATABASE_URL": "postgresql://kdcode:password@localhost:5432/kdcode",
        "OLLAMA_URL": "http://localhost:11434",
        "EMBED_MODEL": "snowflake-arctic-embed2"
      }
    }
  }
}
```

*(Note: Legacy `pg-git-mcp` CLI and `pg_git_*` tool calls remain available as aliases for backward compatibility).*

**4. Start the Web UI (Optional)**
Krusch-Git includes a sleek, dual-pane IDE interface for browsing your semantic repositories.
```bash
npm run dev
```

---

## 🔧 MCP Tools Reference

When running Krusch-Git as an MCP server (`server/mcp.js`), it exposes 7 canonical tools with automatic backward-compatible aliases:

| Canonical Tool | Alias (Backward Compat) | Description |
|---|---|---|
| `krusch_git_list_repos` | `pg_git_list_repos` | List all available repositories indexed in PostgreSQL |
| `krusch_git_read_tree` | `pg_git_read_tree` | Browse repository file tree and directory entries |
| `krusch_git_read_blob` | `pg_git_read_blob` | Read full source file content by blob SHA |
| `krusch_git_semantic_search` | `pg_git_semantic_search` | Hybrid RRF search (dense cosine + BM25 full-text) with temporal decay (`search_type: 'hybrid' \| 'semantic' \| 'keyword'`) |
| `krusch_git_search_symbols` | `pg_git_search_symbols` | Search extracted AST code symbols (functions, classes, methods, routes) across repositories |
| `krusch_git_file_symbols` | `pg_git_file_symbols` | Get all AST symbols declared in a specific file or blob |
| `krusch_git_dependency_graph` | `pg_git_dependency_graph` | Trace inbound callers, outbound imports, and dependencies up to $N$ hops |

---

## 🚀 Real-World Usage Examples

### Standalone Mode

Speak to your IDE agent normally. It will use the standalone MCP tools to interface with the database:

**Example 1: Finding specific logic**
> **You:** "Where do we handle the temporal decay for the memory MCP?"
> **Agent:** *[Calls `krusch_git_semantic_search`]* "I found the logic in `server/git-engine.js`. It uses the `exp(-0.01 * age_in_days)` formula in `searchBlobs()`."

**Example 2: Reading a repository tree**
> **You:** "What is the folder structure for the project?"
> **Agent:** *[Calls `krusch_git_read_tree`]* "Here is the root directory structure..."

**Example 3: Filtering by project**
> **You:** "Search for authentication logic in the pocket-lawyer project only."
> **Agent:** *[Calls `krusch_git_semantic_search` with `project: 'pocket-lawyer'`]* "Found 3 matches in the auth module..."

### How Does Temporal Decay Work?

When calling `krusch_git_semantic_search`, Krusch-Git returns the highest cosine-similarity matches. However, it applies **Exponential Temporal Decay** based on the blob's `last_seen_at` timestamp:

```
score = cosine_similarity × exp(-0.01 × age_in_days)
```

If you have two very similar pieces of code, the *newer* one will have a significantly higher score, preventing your agent from hallucinating based on outdated implementations.

---

## 🤖 The Autonomous Agent Workflow

You can integrate Krusch-Git into your agentic workflow to ensure your semantic memory is always up to date. 

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
Krusch-Git can ingest external documentation (e.g., `llms.txt` manifests) for hallucination-free framework knowledge:

```bash
node scripts/sync_external_docs.js
```

---

## 📂 Project Structure

```
krusch-git/
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
│   ├── ast-chunker.js        # AST symbol extraction and dependency edge builder
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
├── docs/
│   └── TOOL_REFERENCE.md     # Authoritative MCP tool reference and schemas
├── tests/                    # Contract and algorithmic test suites
├── Dockerfile                # Multi-stage production build
├── docker-compose.yml        # Container orchestration
├── AGENTS.md                 # Agent context rules for AI IDEs
├── LICENSE                   # MIT License
└── spec.md                   # Original project specification
```

---

## 🛠️ Configuration & Environment Variables

Krusch-Git uses a layered configuration system: environment variables override `config.json`, which overrides built-in defaults.

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | Express server port | `4890` |
| `DATABASE_URL` / `PG_CONNECTION_STRING` | PostgreSQL connection string | `postgresql://kdcode:password@localhost:5432/kdcode` |
| `DB_HOST` | PostgreSQL Host address | `localhost` |
| `DB_PORT` | PostgreSQL Port | `5432` |
| `DB_NAME` | Database Name | `kdcode` |
| `DB_USER` | Database User | `kdcode` |
| `DB_PASSWORD` | Database Password | `password` |
| `OLLAMA_URL` | The endpoint for your local Ollama instance | `http://localhost:11434` |
| `EMBED_MODEL`| The Ollama text-embedding model to use | `snowflake-arctic-embed2` |

### Database Schema (v1.2.2)

Krusch-Git's PostgreSQL schema maps Git objects and code structure directly into SQL tables:

- **`repositories`** — Project registries
- **`commits`** — SHA-1 identified commit objects with tree and parent references
- **`branches`** — Named references to commit heads
- **`trees`** / **`tree_entries`** — Directory structures mapping names to blob/tree object IDs
- **`blobs`** — File content with `embedding vector(1024)`, `tsv tsvector` (simple full-text BM25 index), and `last_seen_at` temporal tracking
- **`code_symbols`** — Structural AST-extracted functions, classes, methods, and routes with signatures, `embedding vector(1024)` HNSW index, and exact `start_line`/`end_line` ranges
- **`code_symbol_edges`** — Relational dependency graph tracking outbound `imports` and inbound callers/dependents across files

### MCP Tools Reference (v1.2.0)

When running Krusch-Git as an MCP server (`npx krusch-git` or `node server/mcp.js`), the following 7 tools are available:

| Tool Name | Parameters | Description |
|---|---|---|
| `krusch_git_list_repos` | *(none)* | List all available repositories stored in PostgreSQL |
| `krusch_git_read_tree` | `repository_id`, `tree_id?` | Read directory structure (DAG node) of a repo |
| `krusch_git_read_blob` | `blob_id` | Read file contents of a specific blob |
| `krusch_git_semantic_search` | `query`, `search_type?`, `limit?`, `project?`, `repository_id?` | Hybrid RRF (BM25 + pgvector), pure semantic, or keyword search with temporal decay |
| `krusch_git_search_symbols` | `query`, `symbol_type?`, `limit?`, `project?`, `repository_id?` | Search for functions, classes, methods, or routes with signatures and line ranges |
| `krusch_git_file_symbols` | `blob_id` | List all code symbols declared inside a specific file blob |
| `krusch_git_dependency_graph` | `file_path`, `repository_id?`, `project?` | Trace outbound imports, inbound dependents, and declared symbols for a file |

*(Legacy tool calls using `pg_git_*` prefix are automatically redirected).*

### 🔬 Research Foundations (2026 Code-RAG)
- **GRASP (arXiv: 2607.10463)**: Granularity-aware retrieval across symbol definitions and whole-file trees.
- **Reciprocal Rank Fusion (RRF)**: $RRF(d) = \frac{1}{60 + r_{\text{dense}}} + \frac{1}{60 + r_{\text{bm25}}}$, fused with exponential temporal decay $\exp(-0.01 \times age_{\text{days}})$.
- **CodexGraph & CocoIndex**: Structural graph navigation linking call sites, imports, and AST declarations.

---

## 🗺️ Related Projects

| Project | Role |
|---------|------|
| **[Krusch Context MCP](https://github.com/kruschdev/krusch-context-mcp)** | Local 5-verb project memory and invariant steering server (`retrieve`, `remember`, `revise`, `nudge`, `health`) |
| **[Krusch Git](https://github.com/kruschdev/krusch-git)** | Codebase AST, symbol search, Git DAG indexing, and dependency graphs |

## License
MIT License. Created by [kruschdev](https://github.com/kruschdev).
