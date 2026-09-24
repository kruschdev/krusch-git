# 🌳 What Makes `krusch-git` Special

> **Author**: Kevin Ruschman (`kruschdev`)  
> **Version**: v1.2.1  
> **Category**: `#AI` `#MCP` `#DeveloperTools` `#GitDAG` `#AST` `#HybridSearch` `#PostgreSQL` `#pgvector`

![krusch-git Architecture Banner](../assets/banner.png)

> 💡 **Social Caption**:  
> *Why do autonomous coding agents break large codebases? Because grep is blind to AST relationships, and naive vector RAG treats 3-year-old deprecated code the same as yesterday's refactor. What makes krusch-git v1.2.1 special? Indexing the Git DAG into PostgreSQL 16 + pgvector, zero-dependency AST symbol graphs, recursive CTE dependency walks, exponential temporal decay (e^-0.01t), and hybrid Reciprocal Rank Fusion.*

---

## 1. The Core Problem: Why Grep & Flat RAG Fail Autonomous Agents

Autonomous coding agents (Cursor, Claude Code, Windsurf, Codex) routinely fail when navigating mid-to-large codebases:

```
┌─────────────────────────────────────────────────────────────┐
│ ❌ THE TRADITIONAL BLIND SPOTS                              │
│                                                             │
│ 1. Flat Grep: Blind to AST Scope & Call Hierarchies         │
│    - Matches comments, mocks, string literals, and CSS      │
│    - Zero awareness of callers vs. callees                  │
│                                                             │
│ 2. Naive Vector RAG: Temporal Flatness                      │
│    - Deprecated legacy functions rank equally with modern   │
│    - Arbitrary 512-token chunks sever function definitions  │
│                                                             │
│ 3. Context Bloat: Brute-Force File Reading                  │
│    - Reading whole files burns prompt budget on boilerplate │
└─────────────────────────────────────────────────────────────┘
```

1. **Syntactic Blindness (Grep / Text Search)**: When an agent renames a method, grep finds every textual collision across Markdown documentation, obsolete mock fixtures, CSS classes, and comments, but fails to trace dynamic invocations or inherited types.
2. **Temporal Flatness (Naive Vector RAG)**: Standard embeddings treat code written three years ago identically to code committed yesterday. In rapidly evolving codebases, agents hallucinate deprecated patterns because older, redundant files overwhelm the vector space.
3. **Blast Radius Blindness**: When refactoring an interface, an agent has no deterministic way to calculate: *"If I change this function signature, which upstream modules will break?"*

---

## 2. What `krusch-git` Is (and Explicitly What It Is Not)

**`krusch-git` is a persistent Git-DAG, AST symbol graph, and hybrid search intelligence engine for AI coding agents.**

It indexes local and remote Git repositories into a relational **PostgreSQL 16 + pgvector** schema, extracts structural symbols and call edges, computes dense neural embeddings, and exposes **7 canonical MCP tools** over standard stdio.

### Explicit Non-Goals
* **Not a Git Replacement**: It does not execute `merge`, `rebase`, `cherry-pick`, or push commits. Git remains the source of truth for repository history.
* **Not an Ephemeral Cache**: It does not re-index files from scratch on every prompt turn. Trees and blobs are addressed by their immutable SHA-1/SHA-256 hashes.
* **Not a Generic Document Store**: It is purpose-built for programming language ASTs, call graphs, commit lineages, and code recency weighting.

---

## 3. The 7 Canonical Tools Contract

`krusch-git` freezes its agent-facing interface to **7 canonical tools**, supporting dual parameter signatures (`repo` or `repository_id`, `blob_id` or `file_path`) so any agent framework can interact without friction:

| Tool | Signature | Purpose & Mechanics |
| :--- | :--- | :--- |
| **`krusch_git_list_repos`** | `()` | Lists all indexed repositories with commit count, branch heads, and blob totals. |
| **`krusch_git_read_tree`** | `(repo, tree_sha?, path?)` | Inspects directory hierarchy at any point in Git history without disk checkouts. |
| **`krusch_git_read_blob`** | `(repo, blob_sha?, file_path?)` | Retrieves precise blob content by object hash or current branch file path. |
| **`krusch_git_semantic_search`** | `(repo, query, limit?, recency_bias?)` | Hybrid BM25 full-text + pgvector cosine similarity with exponential temporal decay ($e^{-0.01t}$). |
| **`krusch_git_search_symbols`** | `(repo, query, kind?)` | Authoritative AST declaration lookup across classes, functions, and interfaces. |
| **`krusch_git_file_symbols`** | `(repo, file_path)` | Extracts outline of all AST declarations, line ranges, and signatures within a file. |
| **`krusch_git_dependency_graph`** | `(repo, symbol, depth?)` | Multi-hop recursive CTE tracing inbound callers and outbound callees to verify blast radius. |

---

## 4. Systems Architecture: The Git DAG in SQL

Instead of traversing loose Git packfiles on disk, `krusch-git` maps repository topology directly into relational PostgreSQL 16:

```mermaid
erDiagram
    REPOSITORIES ||--o{ COMMITS : contains
    COMMITS ||--o{ GIT_OBJECTS : references
    REPOSITORIES ||--o{ SYMBOLS : declares
    SYMBOLS ||--o{ SYMBOL_EDGES : callers_callees
    GIT_OBJECTS ||--o{ SYMBOLS : extracts_from

    REPOSITORIES {
        uuid id PK
        text name
        text root_path
        timestamp last_indexed_at
    }

    COMMITS {
        text sha PK
        uuid repository_id FK
        text message
        text author
        timestamp committed_at
    }

    GIT_OBJECTS {
        text sha PK
        uuid repository_id FK
        text type
        text path
        vector embedding_1024
        tsvector tsv_content
        bytea content
    }

    SYMBOLS {
        uuid id PK
        uuid repository_id FK
        text name
        text kind
        text file_path
        int start_line
        int end_line
    }

    SYMBOL_EDGES {
        uuid id PK
        uuid caller_id FK
        uuid callee_id FK
        text reference_type
    }
```

### Relational Schema Benefits
1. **Content-Addressable Deduplication**: Blobs are keyed by their cryptographic hash. If 50 files share identical contents across branches, they occupy exactly one row in `git_objects`.
2. **ACID Indexing Transactions**: Parsing and embedding updates execute within serializable database transactions. If indexing is interrupted, the database rolls back cleanly.
3. **Combined Neural + Full-Text Indexes**: Blobs carry an HNSW vector index (`vector_cosine_ops`, 1024-d) and a GIN index (`tsvector`) side-by-side in the same physical table.

---

## 5. Pointer-Mode Resolution for Massive Repositories

Storing gigabytes of raw source text in PostgreSQL `bytea` columns creates unnecessary storage overhead for multi-gigabyte enterprise monorepos.

`krusch-git` provides **Pointer-Mode Resolution**:
* For compact repositories: Blobs are cached directly in PostgreSQL for maximum portability and air-gapped isolation.
* For enterprise monorepos: `git_objects` stores the SHA, relative file path, byte offset, and content length as a pointer. `krusch_git_read_blob` streams the content directly from disk or Git loose packfiles via `git cat-file --batch`, keeping the database lean while maintaining full indexing power.

---

## 6. Transparent Pragmatism: Zero-Dependency AST Lexing

Heavy tree-sitter or LSP compiler wrappers require compiled native binaries (`.node`, `libclang`, `rustc`) that break across host OS architectures (Alpine Linux, macOS ARM64, Ubuntu x86_64).

`krusch-git` implements a **zero-dependency AST lexing pipeline**:
* High-performance deterministic finite-state automata (DFA) and regular expression tokenizers for JavaScript/TypeScript, Python, Go, Rust, and SQL.
* Extracts functions, methods, classes, interfaces, exported types, and import/export declarations with line numbers and scope ranges.
* Runs anywhere Node.js runs without native C++ compilation steps or external binary dependencies.

---

## 7. Relational Symbol Graphs & Recursive Multi-Hop CTEs

The single greatest differentiator between `krusch-git` and general text search is its **relational symbol dependency graph**.

When an agent calls `krusch_git_dependency_graph(repo, 'AuthService.validateToken', depth: 3)`, PostgreSQL executes a recursive Common Table Expression (CTE):

```sql
WITH RECURSIVE dependency_tree AS (
    -- Anchor: Find the target symbol declaration
    SELECT 
        s.id, s.name, s.kind, s.file_path, s.start_line, 0 AS depth,
        ARRAY[s.id] AS path_visited
    FROM symbols s
    WHERE s.repository_id = $1 AND s.name = $2

    UNION ALL

    -- Recursive Step: Trace callers and callees
    SELECT 
        child.id, child.name, child.kind, child.file_path, child.start_line, dt.depth + 1,
        dt.path_visited || child.id
    FROM dependency_tree dt
    JOIN symbol_edges edge ON (edge.caller_id = dt.id OR edge.callee_id = dt.id)
    JOIN symbols child ON (child.id = CASE WHEN edge.caller_id = dt.id THEN edge.callee_id ELSE edge.caller_id END)
    WHERE dt.depth < $3
      AND NOT (child.id = ANY(dt.path_visited))
)
SELECT * FROM dependency_tree ORDER BY depth ASC;
```

### Why This Protects Codebases:
* **Pre-Refactor Blast Radius**: Before an agent alters a public method, it knows every file that invokes it.
* **Dead Code Elimination**: Identifies symbols with zero inbound edges across the entire repository.
* **Circular Dependency Detection**: Detects import cycles before runtime bundling.

---

## 8. Mathematical Recency Prior: Exponential Temporal Decay

In active repositories, code changes constantly. Naive vector search returns obsolete files if their token similarity is slightly higher than newer files.

`krusch-git` counters this with **Exponential Temporal Decay**:

$$\Delta t_{days} = \frac{T_{now} - T_{commit}}{86400 \times 1000}$$

$$S_{temporal} = S_{raw} \times e^{-\lambda \cdot \Delta t_{days}} \quad (\lambda = 0.01)$$

```
Score Multiplier Over Time (λ = 0.01)
1.00 ┤ █ (Today: 1.00)
0.90 ┤ █
0.74 ┤ █ (30 Days: 0.74)
0.50 ┤ █
0.41 ┤ █ (90 Days: 0.41)
0.03 ┤ █ (1 Year: 0.026)
     └───────────────────────────────
       0d     30d    90d    365d
```

* Code modified today retains **100%** of its raw relevance score.
* Code untouched for 30 days retains **74%**.
* Code untouched for 90 days drops to **41%**.
* Code untouched for 1 year drops to **2.6%**.

If a developer refactors the authentication layer today, modern code automatically supersedes year-old legacy files in the search ranking.

---

## 9. Hybrid Reciprocal Rank Fusion (RRF $k=60$) & Empirical Benchmark

`krusch-git` combines sparse BM25 full-text matching with dense neural vectors (Ollama `bge-large` 1024-d or cloud embeddings) via **Reciprocal Rank Fusion**:

$$RRF(d) = \frac{1}{60 + r_{dense}(d)} + \frac{1}{60 + r_{sparse}(d)}$$

### Empirical Foreign Codebench (`expressjs/express`)

To evaluate real-world performance without bias, `krusch-git` was evaluated against the foreign **Express.js** production codebase:

| Query Type | Dense-Only Recall@1 | Sparse-Only (BM25) | krusch-git Hybrid RRF |
| :--- | :--- | :--- | :--- |
| **Exact Function Identifiers** (`router.use`, `app.handle`) | 40.0% | 50.0% | **60.0% (+20% gain)** |
| **Conceptual Queries** (*"middleware dispatch pipeline"*) | 70.0% | 40.0% | **80.0%** |
| **Cross-File Symbol Edges** | 0.0% (unsupported) | 0.0% (unsupported) | **100% via CTE Graph** |

Dense models often stumble on precise camelCase function names (`req.param`), while BM25 stumbles on abstract conceptual searches. Hybrid RRF combines the best of both worlds.

---

## 10. Sibling Synergy: The 3-Tier Coding Agent Stack

`krusch-git` does not operate in isolation. It forms **Tier 2** of the sovereign homelab coding agent stack:

```
┌─────────────────────────────────────────────────────────────┐
│ 1. SESSION START & INVARIANTS                               │
│    krusch-context-mcp (v1.8.0)                              │
│    - 5 Verbs: retrieve, remember, revise, nudge, health     │
│    - SQLite-first (.agent/context.db), token-budget packing │
└──────────────────────────────┬──────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────┐
│ 2. CODE EXPLORATION & ARCHITECTURE                          │
│    krusch-git (v1.2.1)                                      │
│    - Git DAG in PostgreSQL 16 + pgvector                    │
│    - 7 Tools: AST symbols, dependency graphs, hybrid RRF    │
└──────────────────────────────┬──────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────┐
│ 3. STAGED EXECUTION & VERIFICATION                          │
│    krusch (v0.1.0 Harness)                                  │
│    - SHA-256 diff staging, Bubblewrap sandbox, 2PC journal  │
└─────────────────────────────────────────────────────────────┘
```

1. **Tier 1 (`krusch-context-mcp`)**: The host agent begins its session by calling `retrieve({ include_state: true })` to hydrate recorded project decisions, active invariants, and recent lessons into context.
2. **Tier 2 (`krusch-git`)**: When the agent needs to explore the codebase, it calls `search_symbols` and `dependency_graph` to verify AST callers and blast radius before modifying code.
3. **Tier 3 (`krusch-harness`)**: Code mutations are staged as unified diffs and verified inside an isolated Bubblewrap sandbox before being applied to disk.

---

## 11. Quickstart & Host Configuration

### 1. Requirements
* Node.js ≥ 20
* PostgreSQL 16 with `pgvector` extension enabled:
  ```sql
  CREATE EXTENSION IF NOT EXISTS vector;
  ```

### 2. Installation & Indexing
```bash
# Clone and install dependencies
git clone https://github.com/kruschdev/krusch-git.git
cd krusch-git
npm install

# Run database migrations
DATABASE_URL="postgresql://user:pass@localhost:5432/krusch_git" npm run db:migrate

# Index your repository
npm run index -- --repo /path/to/your/project
```

### 3. Agent MCP Configuration
Add to your IDE's MCP configuration (`.cursor/mcp.json` or Claude Code config):

```json
{
  "mcpServers": {
    "krusch-git": {
      "command": "node",
      "args": ["/path/to/krusch-git/bin/krusch-git.js"],
      "env": {
        "DATABASE_URL": "postgresql://user:pass@localhost:5432/krusch_git"
      }
    }
  }
}
```

---

## 12. Summary: Deterministic Code Grounding

Autonomous coding agents cannot rely on guess-and-check text searches. By structuring code as a **relational Git DAG**, mapping call hierarchies with **AST symbol graphs**, and scoring relevance with **temporal recency decay**, `krusch-git` provides agents with the deterministic precision of a compiler and the semantic depth of neural search.
