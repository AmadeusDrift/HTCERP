CREATE TABLE pack_order_batches (
  id TEXT PRIMARY KEY,
  scope_key TEXT NOT NULL,
  export_hash TEXT NOT NULL,
  source_hash TEXT NOT NULL,
  source_key TEXT NOT NULL,
  result_key TEXT NOT NULL,
  filename TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  guard INTEGER NOT NULL CHECK(guard=1),
  UNIQUE(scope_key, export_hash)
);
CREATE INDEX pack_order_batches_recent ON pack_order_batches(created_at DESC, id DESC);
CREATE TABLE pack_order_requests (
  scope_key TEXT NOT NULL,
  request_id TEXT NOT NULL,
  source_hash TEXT NOT NULL,
  batch_id TEXT NOT NULL REFERENCES pack_order_batches(id),
  PRIMARY KEY(scope_key, request_id)
);
CREATE TABLE pack_order_rows (
  scope_key TEXT NOT NULL,
  identity_key TEXT NOT NULL,
  units INTEGER NOT NULL CHECK(units>0),
  batch_id TEXT NOT NULL REFERENCES pack_order_batches(id),
  row_index INTEGER NOT NULL,
  PRIMARY KEY(scope_key, identity_key)
);
CREATE TABLE pack_order_labels (
  batch_id TEXT NOT NULL REFERENCES pack_order_batches(id),
  row_index INTEGER NOT NULL,
  sha256 TEXT,
  object_key TEXT,
  filename TEXT NOT NULL,
  PRIMARY KEY(batch_id, row_index),
  CHECK((sha256 IS NULL AND object_key IS NULL) OR (sha256 IS NOT NULL AND object_key IS NOT NULL))
);
