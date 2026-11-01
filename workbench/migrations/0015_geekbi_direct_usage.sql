-- Paid review reads and free administrator checks share the jobs' atomic D1 budget.
-- Preserve row order for replays of old workflow attempts.
CREATE TABLE usage_next (
  run_id TEXT REFERENCES job_runs(id), step_key TEXT NOT NULL,
  unit TEXT NOT NULL CHECK(unit IN ('points','micros')), business_date TEXT NOT NULL,
  reserved INTEGER NOT NULL CHECK(reserved>=0), actual INTEGER CHECK(actual>=0),
  state TEXT NOT NULL CHECK(state IN ('reserved','confirmed','uncertain')), created_at TEXT NOT NULL,
  attempt INTEGER NOT NULL DEFAULT 0, logical_key TEXT, credential_slot INTEGER NOT NULL DEFAULT 1 CHECK(credential_slot BETWEEN 1 AND 5),
  credential_revision TEXT, balance_refused INTEGER NOT NULL DEFAULT 0 CHECK(balance_refused IN (0,1)),
  direct_key TEXT, test_status TEXT CHECK(test_status IN ('verified','failed')), legacy_binding_match TEXT,
  PRIMARY KEY(run_id,step_key), CHECK((run_id IS NULL) = (direct_key IS NOT NULL))
);
INSERT INTO usage_next(rowid,run_id,step_key,unit,business_date,reserved,actual,state,created_at,attempt,logical_key,credential_slot,credential_revision,balance_refused)
SELECT rowid,run_id,step_key,unit,business_date,reserved,actual,state,created_at,attempt,logical_key,credential_slot,credential_revision,balance_refused FROM usage_reservations;
DROP TABLE usage_reservations;
ALTER TABLE usage_next RENAME TO usage_reservations;
CREATE INDEX usage_day ON usage_reservations(unit,business_date);
CREATE INDEX usage_logical ON usage_reservations(run_id,logical_key,attempt);
CREATE INDEX usage_geekbi_refusals ON usage_reservations(business_date,credential_slot,credential_revision) WHERE balance_refused=1;
CREATE UNIQUE INDEX usage_direct_attempt ON usage_reservations(direct_key,step_key) WHERE direct_key IS NOT NULL;
CREATE INDEX usage_slot_test ON usage_reservations(credential_slot,credential_revision,created_at) WHERE test_status IS NOT NULL;
