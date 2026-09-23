-- Migration 002: Hybrid Search (BM25) and Structural Code Symbols & Graph

-- 1. Full-Text BM25 Lexical Support on Blobs
ALTER TABLE blobs ADD COLUMN IF NOT EXISTS tsv tsvector 
    GENERATED ALWAYS AS (to_tsvector('simple', coalesce(file_name, '') || ' ' || coalesce(file_path, '') || ' ' || coalesce(summary, ''))) STORED;

CREATE INDEX IF NOT EXISTS blobs_tsv_idx ON blobs USING gin(tsv);

-- 2. Code Symbols (Functions, Classes, Methods, Routes)
CREATE TABLE IF NOT EXISTS code_symbols (
    id SERIAL PRIMARY KEY,
    blob_id VARCHAR(40) REFERENCES blobs(id) ON DELETE CASCADE,
    repository_id INTEGER REFERENCES repositories(id) ON DELETE CASCADE,
    file_path TEXT NOT NULL,
    symbol_name VARCHAR(255) NOT NULL,
    symbol_type VARCHAR(50) NOT NULL, -- 'function', 'class', 'method', 'type', 'route', 'variable'
    start_line INTEGER NOT NULL,
    end_line INTEGER NOT NULL,
    signature TEXT,
    content TEXT,
    embedding vector(1024),
    tsv tsvector GENERATED ALWAYS AS (to_tsvector('simple', coalesce(symbol_name, '') || ' ' || coalesce(signature, '') || ' ' || coalesce(content, ''))) STORED,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_code_symbols_blob ON code_symbols(blob_id);
CREATE INDEX IF NOT EXISTS idx_code_symbols_repo_name ON code_symbols(repository_id, symbol_name);
CREATE INDEX IF NOT EXISTS idx_code_symbols_type ON code_symbols(symbol_type);
CREATE INDEX IF NOT EXISTS idx_code_symbols_tsv ON code_symbols USING gin(tsv);
CREATE INDEX IF NOT EXISTS idx_code_symbols_embedding ON code_symbols USING hnsw (embedding vector_cosine_ops);

-- 3. Code Symbol / Dependency Edges (Imports, Requires, References)
CREATE TABLE IF NOT EXISTS code_symbol_edges (
    id SERIAL PRIMARY KEY,
    repository_id INTEGER REFERENCES repositories(id) ON DELETE CASCADE,
    source_blob_id VARCHAR(40) REFERENCES blobs(id) ON DELETE CASCADE,
    source_path TEXT NOT NULL,
    target_path TEXT NOT NULL,
    relation VARCHAR(50) NOT NULL, -- 'imports', 'requires', 'references'
    symbols TEXT[], -- specific imported symbols e.g. ['searchBlobs', 'getBlob']
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_edges_source_blob ON code_symbol_edges(source_blob_id);
CREATE INDEX IF NOT EXISTS idx_edges_repo_target ON code_symbol_edges(repository_id, target_path);
CREATE INDEX IF NOT EXISTS idx_edges_repo_source ON code_symbol_edges(repository_id, source_path);
