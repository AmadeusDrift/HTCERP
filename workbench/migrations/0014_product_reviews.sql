CREATE TABLE IF NOT EXISTS product_review_reports (
  product_key TEXT PRIMARY KEY,
  report_json TEXT,
  updated_at INTEGER NOT NULL DEFAULT 0,
  lease_id TEXT,
  lease_until INTEGER NOT NULL DEFAULT 0
);
