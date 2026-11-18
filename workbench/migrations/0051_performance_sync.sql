CREATE TABLE performance_sync_state (
  seller TEXT NOT NULL, connection_revision TEXT NOT NULL,
  coverage_from TEXT NOT NULL, through_at TEXT, updated_at TEXT NOT NULL,
  PRIMARY KEY(seller,connection_revision)
);
CREATE TABLE performance_sync_runs (
  id TEXT PRIMARY KEY, seller TEXT NOT NULL, connection_revision TEXT NOT NULL,
  basis TEXT NOT NULL CHECK(basis IN ('created','updated')),
  from_at TEXT NOT NULL, through_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('queued','running','complete','failed')),
  pages INTEGER NOT NULL DEFAULT 0, line_count INTEGER NOT NULL DEFAULT 0,
  excluded_orders INTEGER NOT NULL DEFAULT 0, error TEXT,
  started_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX performance_sync_active ON performance_sync_runs(seller) WHERE status IN ('queued','running');
CREATE INDEX performance_sync_latest ON performance_sync_runs(seller,connection_revision,started_at DESC);
CREATE TABLE performance_sync_pages (
  run_id TEXT NOT NULL REFERENCES performance_sync_runs(id), page INTEGER NOT NULL,
  next_token TEXT, line_count INTEGER NOT NULL, excluded_orders INTEGER NOT NULL,
  PRIMARY KEY(run_id,page)
);
CREATE TABLE performance_owner_history (
  id TEXT PRIMARY KEY, seller TEXT NOT NULL, marketplace TEXT NOT NULL, sku TEXT NOT NULL,
  previous_account_id TEXT, account_id TEXT, actor TEXT NOT NULL, changed_at TEXT NOT NULL
);
CREATE INDEX performance_owner_history_sku ON performance_owner_history(seller,marketplace,sku,changed_at);
