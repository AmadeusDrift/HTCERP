CREATE TABLE IF NOT EXISTS product_image_cache (
  cache_key TEXT PRIMARY KEY,
  object_key TEXT,
  content_sha256 TEXT,
  metadata_json TEXT,
  lease_owner TEXT,
  lease_until INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);
