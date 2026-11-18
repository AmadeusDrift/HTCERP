-- Isolated supplement-to-five core. No schedule is enabled by this migration.
CREATE TABLE inventory_replenishment_settings (
  singleton INTEGER PRIMARY KEY CHECK(singleton=1),
  enabled_at INTEGER NOT NULL,
  interval_minutes INTEGER NOT NULL DEFAULT 60 CHECK(interval_minutes>0)
);
CREATE TABLE inventory_replenishment_scans (
  id TEXT PRIMARY KEY, digest TEXT NOT NULL, source TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('patrol','preflight','reconcile')),
  state TEXT NOT NULL CHECK(state IN ('INGESTING','COMPLETE','INCOMPLETE')),
  scanned_at INTEGER NOT NULL, row_count INTEGER NOT NULL
);
CREATE TABLE inventory_replenishment_observations (
  scan_id TEXT NOT NULL REFERENCES inventory_replenishment_scans(id),
  inventory_key TEXT NOT NULL, scope TEXT NOT NULL, channel TEXT,
  observation_json TEXT NOT NULL CHECK(json_valid(observation_json)), observed_at INTEGER NOT NULL,
  action TEXT NOT NULL CHECK(action IN ('receive','skip','review')),
  quantity INTEGER NOT NULL CHECK(quantity BETWEEN 0 AND 5), reason TEXT NOT NULL,
  PRIMARY KEY(scan_id,inventory_key)
);
CREATE TABLE inventory_replenishment_eligibility (
  sku_key TEXT PRIMARY KEY,
  ordered_scan_id TEXT REFERENCES inventory_replenishment_scans(id),
  new_listing_scan_id TEXT REFERENCES inventory_replenishment_scans(id)
);
CREATE TABLE inventory_replenishment_demands (
  inventory_key TEXT PRIMARY KEY, scope TEXT NOT NULL, channel TEXT,
  scan_id TEXT NOT NULL REFERENCES inventory_replenishment_scans(id),
  observation_json TEXT NOT NULL CHECK(json_valid(observation_json)), observed_at INTEGER NOT NULL,
  action TEXT NOT NULL CHECK(action IN ('receive','skip','review')),
  quantity INTEGER NOT NULL CHECK(quantity BETWEEN 0 AND 5), reason TEXT NOT NULL,
  failure_count INTEGER NOT NULL DEFAULT 0, retry_at INTEGER NOT NULL DEFAULT 0,
  paused INTEGER NOT NULL DEFAULT 0 CHECK(paused IN (0,1))
);
CREATE INDEX inventory_replenishment_pending ON inventory_replenishment_demands(scope,channel,paused,retry_at);
CREATE TABLE inventory_replenishment_jobs (
  id TEXT PRIMARY KEY, scope TEXT NOT NULL, channel TEXT NOT NULL,
  lease_id TEXT NOT NULL, lease_until INTEGER NOT NULL, claimed_at INTEGER NOT NULL,
  prepared_at INTEGER, preflight_id TEXT, filename TEXT UNIQUE, file_hash TEXT, submitted_at INTEGER,
  state TEXT NOT NULL CHECK(state IN ('CLAIMED','SUBMITTING','SUBMITTED','SUCCEEDED','PARTIAL','FAILED','UNKNOWN','EXPIRED','SKIPPED'))
);
CREATE TABLE inventory_replenishment_rows (
  id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES inventory_replenishment_jobs(id),
  inventory_key TEXT NOT NULL REFERENCES inventory_replenishment_demands(inventory_key),
  observation_json TEXT NOT NULL CHECK(json_valid(observation_json)),
  quantity INTEGER NOT NULL CHECK(quantity BETWEEN 0 AND 5), preflight_at INTEGER, preflight_id TEXT, file_row INTEGER,
  outcome TEXT NOT NULL DEFAULT 'PENDING' CHECK(outcome IN ('PENDING','SUCCEEDED','FAILED','UNKNOWN','EXPIRED','SKIPPED')),
  active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
  result_event TEXT, resolved_at INTEGER, error TEXT,
  UNIQUE(job_id,inventory_key)
);
CREATE UNIQUE INDEX inventory_replenishment_exclusive ON inventory_replenishment_rows(inventory_key) WHERE active=1;
CREATE INDEX inventory_replenishment_job_rows ON inventory_replenishment_rows(job_id);
CREATE TABLE inventory_replenishment_events (
  job_id TEXT NOT NULL REFERENCES inventory_replenishment_jobs(id), id TEXT NOT NULL,
  digest TEXT NOT NULL, payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
  applied INTEGER NOT NULL DEFAULT 0 CHECK(applied IN (0,1)), received_at INTEGER NOT NULL,
  PRIMARY KEY(job_id,id)
);
