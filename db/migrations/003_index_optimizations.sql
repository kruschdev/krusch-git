-- Migration 003: Performance index optimizations for file_path lookups
CREATE INDEX IF NOT EXISTS idx_blobs_repo_path ON blobs(repository_id, file_path);
CREATE INDEX IF NOT EXISTS idx_blobs_repo_name ON blobs(repository_id, file_name);
CREATE INDEX IF NOT EXISTS idx_code_symbols_repo_path ON code_symbols(repository_id, file_path);
