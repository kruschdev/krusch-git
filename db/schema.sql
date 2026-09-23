-- PostgreSQL Schema for PG-Git

CREATE TABLE IF NOT EXISTS repositories (
    id SERIAL PRIMARY KEY,
    name VARCHAR(255) UNIQUE NOT NULL,
    description TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS commits (
    id VARCHAR(40) PRIMARY KEY, -- SHA1 hash
    repository_id INTEGER REFERENCES repositories(id) ON DELETE CASCADE,
    tree_id VARCHAR(40) NOT NULL,
    parent_id VARCHAR(40) REFERENCES commits(id) ON DELETE SET NULL,
    message TEXT NOT NULL,
    author VARCHAR(255) NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS branches (
    id SERIAL PRIMARY KEY,
    repository_id INTEGER REFERENCES repositories(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    commit_id VARCHAR(40) REFERENCES commits(id) ON DELETE SET NULL,
    UNIQUE(repository_id, name)
);

CREATE TABLE IF NOT EXISTS trees (
    id VARCHAR(40) PRIMARY KEY,
    repository_id INTEGER REFERENCES repositories(id) ON DELETE CASCADE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS tree_entries (
    id SERIAL PRIMARY KEY,
    tree_id VARCHAR(40) REFERENCES trees(id) ON DELETE CASCADE,
    type VARCHAR(10) NOT NULL, -- 'blob' or 'tree'
    name VARCHAR(255) NOT NULL,
    object_id VARCHAR(40) NOT NULL, -- points to either a blob or a tree
    UNIQUE(tree_id, name)
);

CREATE TABLE IF NOT EXISTS blobs (
    id VARCHAR(40) PRIMARY KEY,
    repository_id INTEGER REFERENCES repositories(id) ON DELETE CASCADE,
    content BYTEA NULL,
    size INTEGER NOT NULL,
    file_name VARCHAR(255),
    file_path TEXT,
    summary TEXT,
    storage_mode VARCHAR(10) DEFAULT 'full',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);


-- Optimization Indexes
CREATE INDEX IF NOT EXISTS idx_commits_repo ON commits(repository_id);
CREATE INDEX IF NOT EXISTS idx_tree_entries_tree ON tree_entries(tree_id);

-- Semantic Embedding & Full-Text Extensions
CREATE EXTENSION IF NOT EXISTS vector;
ALTER TABLE blobs ADD COLUMN IF NOT EXISTS embedding vector(1024);
ALTER TABLE blobs ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE blobs ADD COLUMN IF NOT EXISTS tsv tsvector 
    GENERATED ALWAYS AS (to_tsvector('simple', coalesce(file_name, '') || ' ' || coalesce(file_path, '') || ' ' || coalesce(summary, ''))) STORED;

CREATE INDEX IF NOT EXISTS blobs_embedding_idx ON blobs USING hnsw (embedding vector_cosine_ops);
CREATE INDEX IF NOT EXISTS blobs_tsv_idx ON blobs USING gin(tsv);

-- Code Symbols (Functions, Classes, Methods, Routes)
CREATE TABLE IF NOT EXISTS code_symbols (
    id SERIAL PRIMARY KEY,
    blob_id VARCHAR(40) REFERENCES blobs(id) ON DELETE CASCADE,
    repository_id INTEGER REFERENCES repositories(id) ON DELETE CASCADE,
    file_path TEXT NOT NULL,
    symbol_name VARCHAR(255) NOT NULL,
    symbol_type VARCHAR(50) NOT NULL,
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

-- Code Symbol / Dependency Edges (Imports, Requires, References)
CREATE TABLE IF NOT EXISTS code_symbol_edges (
    id SERIAL PRIMARY KEY,
    repository_id INTEGER REFERENCES repositories(id) ON DELETE CASCADE,
    source_blob_id VARCHAR(40) REFERENCES blobs(id) ON DELETE CASCADE,
    source_path TEXT NOT NULL,
    target_path TEXT NOT NULL,
    relation VARCHAR(50) NOT NULL,
    symbols TEXT[],
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_edges_source_blob ON code_symbol_edges(source_blob_id);
CREATE INDEX IF NOT EXISTS idx_edges_repo_target ON code_symbol_edges(repository_id, target_path);
CREATE INDEX IF NOT EXISTS idx_edges_repo_source ON code_symbol_edges(repository_id, source_path);

