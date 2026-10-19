-- Migration 004: CrushGit Hardening & Index Acceleration (INV-GIT-01, INV-GIT-02, INV-GIT-04)

-- 1. Enable trigram extension for fast ILIKE substring matching
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- 2. Add per-symbol SHA-256 hash column
ALTER TABLE code_symbols ADD COLUMN IF NOT EXISTS symbol_hash VARCHAR(64);

-- 3. Remove stale historical symbol rows from superseded blob SHAs for the same (repository_id, file_path)
WITH latest_blobs AS (
    SELECT DISTINCT ON (repository_id, file_path) id, repository_id, file_path
    FROM blobs
    WHERE file_path IS NOT NULL
    ORDER BY repository_id, file_path, last_seen_at DESC NULLS LAST, created_at DESC NULLS LAST
)
DELETE FROM code_symbols s
USING latest_blobs lb
WHERE s.repository_id = lb.repository_id
  AND s.file_path = lb.file_path
  AND s.blob_id IS DISTINCT FROM lb.id;

-- 4. Remove exact duplicate symbol rows within the same (repository_id, file_path, symbol_name, symbol_type, start_line)
DELETE FROM code_symbols a
USING code_symbols b
WHERE a.id < b.id
  AND a.repository_id = b.repository_id
  AND a.file_path = b.file_path
  AND a.symbol_name = b.symbol_name
  AND a.symbol_type = b.symbol_type
  AND a.start_line = b.start_line;

-- 5. Remove stale historical edge rows from superseded blob SHAs for the same (repository_id, source_path)
WITH latest_blobs AS (
    SELECT DISTINCT ON (repository_id, file_path) id, repository_id, file_path
    FROM blobs
    WHERE file_path IS NOT NULL
    ORDER BY repository_id, file_path, last_seen_at DESC NULLS LAST, created_at DESC NULLS LAST
)
DELETE FROM code_symbol_edges e
USING latest_blobs lb
WHERE e.repository_id = lb.repository_id
  AND e.source_path = lb.file_path
  AND e.source_blob_id IS DISTINCT FROM lb.id;

-- 6. Remove exact duplicate edge rows within the same (repository_id, source_path, target_path, relation)
DELETE FROM code_symbol_edges a
USING code_symbol_edges b
WHERE a.id < b.id
  AND a.repository_id = b.repository_id
  AND a.source_path = b.source_path
  AND a.target_path = b.target_path
  AND a.relation = b.relation;

-- 7. Backfill missing symbol_hash values deterministically
UPDATE code_symbols
SET symbol_hash = encode(sha256(convert_to(coalesce(content, signature, symbol_name, ''), 'UTF8')), 'hex')
WHERE symbol_hash IS NULL;

-- 8. Create functional B-Tree and GIN trigram indexes to eliminate sequential scans
CREATE INDEX IF NOT EXISTS idx_code_symbols_lower_name ON code_symbols (LOWER(symbol_name));
CREATE INDEX IF NOT EXISTS idx_code_symbols_name_trgm ON code_symbols USING gin (symbol_name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_edges_target_trgm ON code_symbol_edges USING gin (target_path gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_blobs_path_trgm ON blobs USING gin (file_path gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_blobs_name_trgm ON blobs USING gin (file_name gin_trgm_ops);
