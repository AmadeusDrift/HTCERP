-- Read-only Amazon source candidates. These tables never populate execution demands.
CREATE TABLE inventory_source_settings (
  singleton INTEGER PRIMARY KEY CHECK(singleton=1), enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN(0,1)),
  mode TEXT NOT NULL DEFAULT 'READ_ONLY' CHECK(mode='READ_ONLY'),
  interval_minutes INTEGER NOT NULL DEFAULT 60 CHECK(interval_minutes BETWEEN 5 AND 10080),
  activated_at INTEGER, updated_at INTEGER NOT NULL
);
INSERT INTO inventory_source_settings VALUES(1,0,'READ_ONLY',60,NULL,0);
CREATE TABLE inventory_source_runs (
  id TEXT PRIMARY KEY, seller TEXT NOT NULL, marketplace TEXT NOT NULL DEFAULT 'ATVPDKIKX0DER',
  started_at INTEGER NOT NULL, activated_at INTEGER NOT NULL, order_from INTEGER NOT NULL, order_through INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'RUNNING' CHECK(state IN('RUNNING','COMPLETE','FAILED')),
  finished_at INTEGER, error TEXT,
  connection_revision TEXT,
  inventory_status TEXT NOT NULL DEFAULT 'PENDING', listings_status TEXT NOT NULL DEFAULT 'PENDING', orders_status TEXT NOT NULL DEFAULT 'PENDING',
  inventory_report TEXT, listings_report TEXT, inventory_source_at TEXT, listings_source_at TEXT,
  inventory_coverage TEXT, listings_coverage TEXT,
  inventory_count INTEGER NOT NULL DEFAULT 0, listings_count INTEGER NOT NULL DEFAULT 0, orders_count INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX inventory_source_single_running ON inventory_source_runs(seller) WHERE state='RUNNING';
CREATE TABLE inventory_source_rows (
  generation TEXT NOT NULL REFERENCES inventory_source_runs(id), sku TEXT NOT NULL, channel TEXT NOT NULL CHECK(channel IN('J1T','JIT')),
  sellable INTEGER, created_at INTEGER, listing_status TEXT NOT NULL DEFAULT 'unknown', listing_status_raw TEXT,
  ordered INTEGER CHECK(ordered IS NULL OR ordered=1), new_listing INTEGER NOT NULL DEFAULT 0,
  inventory_chunk INTEGER, listings_chunk INTEGER, ordered_evidence TEXT,
  stock_source TEXT NOT NULL DEFAULT 'FBA_REPORT_UNVERIFIED', creation_source TEXT,
  PRIMARY KEY(generation,sku)
);
CREATE INDEX inventory_source_rows_priority ON inventory_source_rows(generation,channel,sku);
CREATE TABLE inventory_source_qualifications (
  seller TEXT NOT NULL, sku TEXT NOT NULL, ordered_generation TEXT, new_generation TEXT,
  PRIMARY KEY(seller,sku)
);
CREATE TABLE inventory_source_current (
  seller TEXT PRIMARY KEY, generation TEXT NOT NULL REFERENCES inventory_source_runs(id), published_at INTEGER NOT NULL
);
