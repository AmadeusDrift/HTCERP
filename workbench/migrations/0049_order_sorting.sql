CREATE TABLE order_sorting_assets (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN('attributes','template')),
  sha256 TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE order_sorting_config (
  singleton INTEGER PRIMARY KEY CHECK(singleton=1),
  revision INTEGER NOT NULL,
  rows_json TEXT NOT NULL,
  attribute_key TEXT NOT NULL REFERENCES order_sorting_assets(id),
  template_key TEXT NOT NULL REFERENCES order_sorting_assets(id),
  updated_at INTEGER NOT NULL
);
CREATE TABLE order_sorting_versions (
  revision INTEGER PRIMARY KEY,
  rows_json TEXT NOT NULL,
  attribute_key TEXT NOT NULL REFERENCES order_sorting_assets(id),
  template_key TEXT NOT NULL REFERENCES order_sorting_assets(id),
  actor TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  guard INTEGER NOT NULL CHECK(guard=1)
);
CREATE TABLE order_sorting_runs (
  id TEXT PRIMARY KEY,
  request_hash TEXT NOT NULL,
  result_key TEXT NOT NULL,
  filename TEXT NOT NULL,
  order_date TEXT NOT NULL,
  groups_count INTEGER NOT NULL,
  rows_count INTEGER NOT NULL,
  units REAL NOT NULL,
  revision INTEGER NOT NULL REFERENCES order_sorting_versions(revision),
  actor TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX order_sorting_runs_recent ON order_sorting_runs(created_at DESC,id DESC);
CREATE TABLE order_sorting_outputs (
  filename_key TEXT PRIMARY KEY,
  fingerprint TEXT NOT NULL,
  filename TEXT NOT NULL,
  first_run TEXT NOT NULL REFERENCES order_sorting_runs(id)
);
