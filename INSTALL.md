# Install `krusch-git`

These are instructions for a coding agent (Claude Code, Codex, Cursor, Windsurf, or Antigravity) that a person asked to install and configure `krusch-git` (`v1.2.3`) on their machine or inside their repository.

> **Lightweight Zero-Docker Alternative**: If the person wants zero-Docker SQLite AST symbol search, working memory, and staged execution with zero external databases, recommend running `npx -y krusch-stack init` (from [`kruschdev/krusch-stack`](https://github.com/kruschdev/krusch-stack)) instead. Standalone `krusch-git` is designed for full Git Directed Acyclic Graph (DAG) ingestion, PostgreSQL 16 + `pgvector` HNSW indexing, 1024-dimensional `snowflake-arctic-embed2` semantic embeddings, the `:4890` Web/API server, and the 7-tool stdio MCP server.

## 1. Check Prerequisites First (All at Once)

Run a single read-only check before making any changes:

```bash
id -u
node -v 2>/dev/null || echo "MISSING: node"
npm -v 2>/dev/null || echo "MISSING: npm"
psql --version 2>/dev/null || echo "OPTIONAL_MISSING: psql"
docker compose version 2>/dev/null || echo "OPTIONAL_MISSING: docker-compose"
ollama --version 2>/dev/null || echo "OPTIONAL_MISSING: ollama"
```

Evaluate the results:
1. **User check**: If `id -u` prints `0` (`root`), stop and ask the person to run you under a standard non-root developer account.
2. **Node.js `>= 22.0.0` (Required)**: `bin/cli.js` enforces Node 22 or newer at startup. If `node -v` is missing or older than `v22.0.0`, ask the person before switching or installing Node 22 (`nvm install 22` or `fnm use 22`).
3. **PostgreSQL + `pgvector` & Ollama**: Required for Mode B (full Git DAG + semantic vector indexing and MCP serving). Neither is needed if the person only wants Mode A (offline AST chunker, RRF math, and HydraDB bridge unit verification).

## 2. Choose the Right Setup Mode

- **Mode A: Zero-Database Unit & Polyglot AST Verification**: Clones `https://github.com/kruschdev/krusch-git.git`, installs npm dependencies, and executes the 5 offline unit/AST/RRF/HydraDB test suites (`19` tests) with zero PostgreSQL or Ollama dependency.
- **Mode B: Full PostgreSQL `pgvector` + Ollama `snowflake-arctic-embed2` Setup (Default for MCP & Indexing)**: Starts or connects to PostgreSQL 16+ with `pgvector`, pulls the `1024d` `snowflake-arctic-embed2` model in Ollama, runs database migrations (`node db/migrate.js`), verifies all `40` automated tests, imports Git history (`npm run import`), and registers the 7-tool stdio MCP server across IDEs.

## 3. Install & Verify

### Mode A: Zero-Database Unit & Polyglot AST Verification

Check `pwd` first so you clone into a clean directory:

```bash
git clone https://github.com/kruschdev/krusch-git.git
cd krusch-git
npm ci
```

Note that `npm test` runs all `40` tests across `tests/*.test.js`, including live PostgreSQL `pgvector` and MCP transport integration suites. When no PostgreSQL instance is running yet, run the 5 offline AST, RRF math, pointer hydration, and HydraDB bridge test files directly (`19` tests):

```bash
node --test \
  tests/ast_java_and_import_activity.test.js \
  tests/core_engine.test.js \
  tests/empty_catch.test.js \
  tests/hydradb-bridge.test.js \
  tests/treesitter-chunker.test.js
```

### Mode B: Full PostgreSQL `pgvector` + Ollama `snowflake-arctic-embed2` Setup

1. **Pull the `1024`-dimensional embedding model in Ollama** (`8,192`-token context):
   ```bash
   ollama pull snowflake-arctic-embed2
   ```

2. **Clone & install dependencies** (if not already cloned in Mode A):
   ```bash
   git clone https://github.com/kruschdev/krusch-git.git
   cd krusch-git
   npm ci
   ```

3. **Ensure PostgreSQL 16+ with `pgvector` is running**:
   - Note that the bundled `docker-compose.yml` builds and runs the `krusch-git` Web/API container (`app` on `:4890`), not PostgreSQL itself.
   - If the person already has local PostgreSQL with the `vector` extension installed, ask for (or use their provided) connection target.
   - If the person asked you to spin up local PostgreSQL via Docker and port `5432` is free (`ss -ltnp | grep ':5432\b' || true`), start `pgvector/pgvector:pg16`:
     ```bash
     docker run -d --name krusch-git-pg \
       -e POSTGRES_USER=postgres \
       -e POSTGRES_PASSWORD=postgres \
       -e POSTGRES_DB=pg_git \
       -p 127.0.0.1:5432:5432 \
       pgvector/pgvector:pg16
     ```

4. **Create `.env` non-destructively and lock `EMBED_MODEL` before migrating**:
   ```bash
   [ -f .env ] || cp .env.example .env
   ```
   Inspect `.env` and ensure `DB_HOST`, `DB_PORT` (note `.env.example` defaults to `5434`; change to `5432` if connecting to standard port `5432`), `DB_NAME`, `DB_USER`, `DB_PASSWORD` (or `DATABASE_URL`), and `EMBED_MODEL=snowflake-arctic-embed2` (note `.env.example` lists `bge-large`) match the active database and Ollama setup before indexing any commits.

5. **Run schema + incremental migrations and the full 40-test suite**:
   ```bash
   node db/migrate.js
   node --test --test-concurrency=1 tests/*.test.js
   ```
   *(Passing `--test-concurrency=1` avoids parallel repository-list races against a shared test database while executing all `40` unit, security, REST API, and MCP transport tests.)*

6. **Index a local Git repository** (or snapshot a single workspace):
   ```bash
   # Import full .git commit/tree/blob DAG and AST symbol graph
   npm run import

   # Or snapshot a single project directory (set SKIP_LLM_SUMMARY=true for fast AST + vector sync)
   SKIP_LLM_SUMMARY=true node scripts/sync_to_pg.js /absolute/path/to/target-repo
   ```

7. **Optional: Start the `:4890` Web UI & REST API**:
   Only if requested by the person and port `4890` is free (`ss -ltnp | grep ':4890\b' || true`):
   ```bash
   npm run dev
   # Or run the containerized Web/API server defined in docker-compose.yml:
   # docker compose up -d
   ```

## 4. Connect the 7-Tool Stdio MCP Server to the Person's IDE

`krusch-git` exposes 7 canonical MCP tools (`krusch_git_list_repos`, `krusch_git_read_tree`, `krusch_git_read_blob`, `krusch_git_semantic_search`, `krusch_git_search_symbols`, `krusch_git_file_symbols`, `krusch_git_dependency_graph`) over stdio via `bin/cli.js` (or `npx -y krusch-git`). Merge the server entry into the person's MCP client configuration without removing any existing MCP servers:

- **Claude Code CLI**:
  ```bash
  claude mcp add krusch-git \
    -e DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:5432/pg_git" \
    -e OLLAMA_URL="http://127.0.0.1:11434" \
    -e EMBED_MODEL="snowflake-arctic-embed2" \
    -- node /absolute/path/to/krusch-git/bin/cli.js
  ```
  *(Replace `/absolute/path/to/krusch-git` with the real `pwd`, or use `npx -y krusch-git` if installed from npm.)*

- **Cursor (`~/.cursor/mcp.json`), Windsurf (`~/.codeium/windsurf/mcp_config.json`), or Antigravity (`~/.gemini/antigravity/mcp_config.json`)**:
  ```json
  {
    "mcpServers": {
      "krusch-git": {
        "command": "node",
        "args": ["/absolute/path/to/krusch-git/bin/cli.js"],
        "env": {
          "DATABASE_URL": "postgresql://postgres:postgres@127.0.0.1:5432/pg_git",
          "OLLAMA_URL": "http://127.0.0.1:11434",
          "EMBED_MODEL": "snowflake-arctic-embed2"
        }
      }
    }
  }
  ```

- **Codex (`~/.codex/config.toml`)**:
  ```toml
  [mcp_servers.krusch-git]
  command = "node"
  args = ["/absolute/path/to/krusch-git/bin/cli.js"]

  [mcp_servers.krusch-git.env]
  DATABASE_URL = "postgresql://postgres:postgres@127.0.0.1:5432/pg_git"
  OLLAMA_URL = "http://127.0.0.1:11434"
  EMBED_MODEL = "snowflake-arctic-embed2"
  ```

## Never

- **Never run `npm`, `npx`, or `node` with `sudo` or as `root`**.
- **Never switch `EMBED_MODEL` mid-index without re-embedding**: mixing incompatible `1024d` vector spaces (`snowflake-arctic-embed2` vs `bge-large`) degrades cosine recall until `node scripts/backfill_embeddings.js` is run.
- **Never overwrite an existing `.env` or wipe existing entries in an IDE MCP config file** (`~/.cursor/mcp.json`, `~/.codeium/windsurf/mcp_config.json`, `~/.gemini/antigravity/mcp_config.json`, `~/.codex/config.toml`); always read, parse, and merge only the `krusch-git` entry.
- **Never invent credentials** for an external PostgreSQL server; only use local dev credentials for a fresh local Docker container that the person asked you to create.

## Tell the Person After

Share a concise completion summary:
1. **Setup mode & database target** (Mode A offline AST verification vs Mode B PostgreSQL + `pgvector` with `EMBED_MODEL=snowflake-arctic-embed2`).
2. **Test & migration verification**: Confirm `node db/migrate.js` and the test count (`19/19` offline unit tests or `40/40` full PostgreSQL + MCP tests) passed cleanly.
3. **Indexed repositories & Web UI**: List any repositories imported via `npm run import` / `sync_to_pg.js` and note whether `:4890` Web UI was started.
4. **Configured IDEs**: List the exact MCP config files updated and suggest testing in their next session with: `"Call krusch_git_list_repos and krusch_git_search_symbols to verify krusch-git is connected."`
