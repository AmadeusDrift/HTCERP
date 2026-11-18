-- Session-bound one-time connection grants. No bearer credential or verifier is stored.
CREATE TABLE inventory_connection_grants (
  id TEXT PRIMARY KEY, request_id TEXT NOT NULL UNIQUE, actor_id TEXT NOT NULL,
  session_hash TEXT NOT NULL, scope_json TEXT NOT NULL, challenge TEXT NOT NULL,
  name TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
  device_id TEXT NOT NULL UNIQUE
);
CREATE TABLE inventory_executors (
  scope_json TEXT PRIMARY KEY, device_id TEXT, version INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);
CREATE TABLE inventory_executor_events (
  request_id TEXT PRIMARY KEY, payload_json TEXT NOT NULL, scope_json TEXT NOT NULL,
  actor TEXT NOT NULL, old_device_id TEXT, new_device_id TEXT NOT NULL,
  trial_id TEXT, version INTEGER NOT NULL, created_at INTEGER NOT NULL,
  applied INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE inventory_device_transfers (
  request_id TEXT NOT NULL REFERENCES inventory_executor_events(request_id),
  job_id TEXT NOT NULL, scope_json TEXT NOT NULL, old_device_id TEXT NOT NULL,
  old_lease_id TEXT NOT NULL, new_device_id TEXT NOT NULL, new_lease_id TEXT NOT NULL,
  submitted INTEGER NOT NULL, created_at INTEGER NOT NULL,
  PRIMARY KEY(job_id,old_lease_id)
);
