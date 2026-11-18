-- Explicit, bounded administrator trials only. This never enables scheduled execution.
CREATE TABLE inventory_live_trials (
  id TEXT PRIMARY KEY, seller TEXT NOT NULL, connection_revision TEXT NOT NULL,
  scope_json TEXT NOT NULL CHECK(json_valid(scope_json)),
  skus_json TEXT NOT NULL CHECK(json_valid(skus_json) AND json_array_length(skus_json) BETWEEN 1 AND 2),
  actor TEXT NOT NULL, created_at INTEGER NOT NULL, ended_at INTEGER,
  device_id TEXT, claim_token TEXT, state TEXT NOT NULL, error TEXT,
  snapshot_json TEXT, updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX inventory_live_single_active ON inventory_live_trials((1)) WHERE ended_at IS NULL;
CREATE TABLE inventory_live_jobs (
  job_id TEXT PRIMARY KEY REFERENCES inventory_replenishment_jobs(id),
  trial_id TEXT NOT NULL REFERENCES inventory_live_trials(id),
  created_at INTEGER NOT NULL
);
CREATE INDEX inventory_live_trial_jobs ON inventory_live_jobs(trial_id,created_at);
CREATE TABLE inventory_live_events (
  job_id TEXT NOT NULL REFERENCES inventory_replenishment_jobs(id), event_id TEXT NOT NULL,
  digest TEXT NOT NULL, payload_json TEXT NOT NULL, archive_key TEXT,
  received_at INTEGER NOT NULL, applied INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(job_id,event_id)
);
