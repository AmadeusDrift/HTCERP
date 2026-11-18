-- Device transport is simulation-only. It cannot claim real replenishment jobs.
CREATE TABLE inventory_device_pairs (
  code_hash TEXT PRIMARY KEY, scope_json TEXT NOT NULL,
  expires_at INTEGER NOT NULL, consumed_at INTEGER, actor TEXT NOT NULL
);
CREATE TABLE inventory_devices (
  id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
  scope_json TEXT NOT NULL, paired_at INTEGER NOT NULL, last_seen INTEGER,
  revoked_at INTEGER
);
CREATE TABLE inventory_device_tests (
  id TEXT PRIMARY KEY, device_id TEXT NOT NULL REFERENCES inventory_devices(id),
  nonce TEXT NOT NULL, rows_json TEXT NOT NULL, expected_hash TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('PENDING','PASSED')),
  created_at INTEGER NOT NULL, completed_at INTEGER, result_json TEXT
);
CREATE UNIQUE INDEX inventory_device_pending_test ON inventory_device_tests(device_id) WHERE state='PENDING';
