CREATE TABLE strategy_versions (
  version INTEGER PRIMARY KEY, settings_json TEXT NOT NULL CHECK(json_valid(settings_json)),
  actor TEXT NOT NULL, created_at TEXT NOT NULL
);
INSERT INTO strategy_versions VALUES(1,'{"platform":"temu","market":"US","categoryId":"home","keyword":"","maxPrice":4,"tiers":[50000,30000,10000],"pageLimit":1,"focusLimit":0,"dataDailyPoints":0,"aiDailyMicros":0,"scheduleEnabled":false,"scheduleTime":""}','system',strftime('%Y-%m-%dT%H:%M:%fZ','now'));

CREATE TABLE job_runs (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('discovery','research')),
  status TEXT NOT NULL, title TEXT NOT NULL, strategy_version INTEGER NOT NULL REFERENCES strategy_versions(version),
  inputs_json TEXT NOT NULL, actor TEXT NOT NULL, request_key TEXT NOT NULL UNIQUE, attempt INTEGER NOT NULL DEFAULT 0,
  summary TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX job_list ON job_runs(created_at DESC,id DESC);
CREATE TABLE job_steps (
  run_id TEXT NOT NULL REFERENCES job_runs(id), step_key TEXT NOT NULL, title TEXT NOT NULL,
  status TEXT NOT NULL, summary TEXT NOT NULL, result_json TEXT NOT NULL, evidence_ref TEXT,
  updated_at TEXT NOT NULL, PRIMARY KEY(run_id,step_key)
);
CREATE TABLE job_seen (
  run_id TEXT NOT NULL REFERENCES job_runs(id), product_id TEXT NOT NULL, tier INTEGER, first_page INTEGER NOT NULL,
  PRIMARY KEY(run_id,product_id)
);
-- Daily limits are shared across all keys of the single configured source account.
-- A single conditional INSERT checks both caps and job state and reserves the call.
CREATE TABLE usage_reservations (
  run_id TEXT NOT NULL REFERENCES job_runs(id), step_key TEXT NOT NULL, unit TEXT NOT NULL CHECK(unit IN ('points','micros')),
  business_date TEXT NOT NULL, reserved INTEGER NOT NULL CHECK(reserved>=0), actual INTEGER CHECK(actual>=0),
  state TEXT NOT NULL CHECK(state IN ('reserved','confirmed','uncertain')), created_at TEXT NOT NULL,
  PRIMARY KEY(run_id,step_key)
);
CREATE INDEX usage_day ON usage_reservations(unit,business_date);
