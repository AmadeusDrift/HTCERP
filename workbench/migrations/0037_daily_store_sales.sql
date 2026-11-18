CREATE TABLE daily_sales_team_members (
  team TEXT NOT NULL CHECK(team IN ('a','b','c')),
  account_id TEXT NOT NULL PRIMARY KEY REFERENCES accounts(id)
);
CREATE TABLE daily_sales_runs (
  id TEXT PRIMARY KEY,
  report_date TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('running','ready','failed')),
  report_json TEXT,
  error TEXT,
  updated_at TEXT NOT NULL
);
CREATE INDEX daily_sales_runs_latest ON daily_sales_runs(updated_at DESC);

CREATE TABLE daily_sales_destination (
  singleton INTEGER PRIMARY KEY CHECK(singleton=1),
  group_id TEXT NOT NULL REFERENCES notification_groups(id)
);

CREATE TABLE daily_sales_sku_teams (
  sku TEXT PRIMARY KEY,
  team TEXT NOT NULL CHECK(team IN ('a','b','c'))
);

CREATE TABLE notification_routes_next (
  service TEXT PRIMARY KEY CHECK(service IN ('feedback','infringement','daily-sales')),
  group_id TEXT NOT NULL REFERENCES notification_groups(id), activated_at TEXT NOT NULL
);
INSERT INTO notification_routes_next SELECT service,group_id,activated_at FROM notification_routes;
DROP TABLE notification_routes;
ALTER TABLE notification_routes_next RENAME TO notification_routes;

CREATE TABLE notification_deliveries_next (
  id TEXT PRIMARY KEY, service TEXT NOT NULL CHECK(service IN ('feedback','infringement','daily-sales')),
  group_id TEXT NOT NULL REFERENCES notification_groups(id), account_id TEXT REFERENCES accounts(id),
  trial INTEGER NOT NULL DEFAULT 0 CHECK(trial IN (0,1)), content TEXT NOT NULL, image TEXT,
  phase TEXT NOT NULL DEFAULT 'text' CHECK(phase IN ('text','image')),
  status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','sending','sent','failed','unknown','cancelled')),
  attempts INTEGER NOT NULL DEFAULT 0, error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  CHECK((service='daily-sales' AND account_id IS NULL AND phase='text' AND image IS NULL)
    OR (service<>'daily-sales' AND account_id IS NOT NULL))
);
INSERT INTO notification_deliveries_next
  SELECT id,service,group_id,account_id,trial,content,image,phase,status,attempts,error,created_at,updated_at
  FROM notification_deliveries;
DROP TABLE notification_deliveries;
ALTER TABLE notification_deliveries_next RENAME TO notification_deliveries;
CREATE INDEX notification_deliveries_pending ON notification_deliveries(status,created_at);
