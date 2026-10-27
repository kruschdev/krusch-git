-- Migration 005: Context v2 Lessons — embed_model Tracking, AST Symbol Spine & Stemmed Weighted blobs.tsv (INV-GIT-SCHEMA-02)

-- 1. Add vector-space model tracking and AST symbol spine columns idempotently
ALTER TABLE blobs ADD COLUMN IF NOT EXISTS embed_model VARCHAR(128);
ALTER TABLE blobs ADD COLUMN IF NOT EXISTS symbol_spine TEXT;
ALTER TABLE code_symbols ADD COLUMN IF NOT EXISTS embed_model VARCHAR(128);

-- 2. Backfill blobs.symbol_spine from existing code_symbols BEFORE rebuilding blobs.tsv
WITH spine_agg AS (
    SELECT
        s.blob_id,
        LEFT(string_agg(DISTINCT s.symbol_name, ' ' ORDER BY s.symbol_name), 4000) AS spine
    FROM code_symbols s
    WHERE s.blob_id IS NOT NULL
    GROUP BY s.blob_id
)
UPDATE blobs b
SET symbol_spine = spine_agg.spine
FROM spine_agg
WHERE b.id = spine_agg.blob_id
  AND (b.symbol_spine IS NULL OR b.symbol_spine = '');

-- 3. Rebuild blobs.tsv idempotently with weighted simple + english camelCase/delimiter-split + symbol_spine + summary
DO $$
DECLARE
    v_expr TEXT;
BEGIN
    SELECT pg_get_expr(d.adbin, d.adrelid)
      INTO v_expr
      FROM pg_attribute a
      JOIN pg_class c ON c.oid = a.attrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
     WHERE n.nspname = current_schema()
       AND c.relname = 'blobs'
       AND a.attname = 'tsv'
       AND a.attnum > 0
       AND NOT a.attisdropped;

    IF v_expr IS NULL OR position('symbol_spine' IN v_expr) = 0 OR position('setweight' IN v_expr) = 0 THEN
        ALTER TABLE blobs DROP COLUMN IF EXISTS tsv;
        ALTER TABLE blobs ADD COLUMN tsv tsvector GENERATED ALWAYS AS (
            setweight(to_tsvector('simple', coalesce(file_name, '') || ' ' || coalesce(file_path, '')), 'A') ||
            setweight(to_tsvector('english', translate(regexp_replace(coalesce(file_name, '') || ' ' || coalesce(file_path, '') || ' ' || coalesce(symbol_spine, ''), '([a-z0-9])([A-Z])', '\1 \2', 'g'), '_/.-', '    ')), 'A') ||
            setweight(to_tsvector('simple', coalesce(symbol_spine, '')), 'B') ||
            setweight(to_tsvector('english', coalesce(summary, '')), 'C')
        ) STORED;
    END IF;
END $$;

-- 4. Provision GIN and B-Tree indexes for tsv, latest-blob deduplication, and vector-space filtering
CREATE INDEX IF NOT EXISTS blobs_tsv_idx ON blobs USING gin(tsv);
CREATE INDEX IF NOT EXISTS idx_blobs_repo_path_seen ON blobs (repository_id, file_path, last_seen_at DESC);
CREATE INDEX IF NOT EXISTS idx_blobs_embed_model ON blobs (embed_model);
