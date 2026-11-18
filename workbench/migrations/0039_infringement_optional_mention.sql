CREATE TABLE notification_deliveries_next (
  id TEXT PRIMARY KEY, service TEXT NOT NULL CHECK(service IN ('feedback','infringement','daily-sales')),
  group_id TEXT NOT NULL REFERENCES notification_groups(id), account_id TEXT REFERENCES accounts(id),
  trial INTEGER NOT NULL DEFAULT 0 CHECK(trial IN (0,1)), content TEXT NOT NULL, image TEXT,
  phase TEXT NOT NULL DEFAULT 'text' CHECK(phase IN ('text','image')),
  status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','sending','sent','failed','unknown','cancelled')),
  attempts INTEGER NOT NULL DEFAULT 0, error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  CHECK((service='daily-sales' AND account_id IS NULL AND phase='text' AND image IS NULL)
    OR (service='infringement' AND trial=0)
    OR (service IN ('feedback','infringement') AND account_id IS NOT NULL))
);
INSERT INTO notification_deliveries_next
  SELECT id,service,group_id,account_id,trial,content,image,phase,status,attempts,error,created_at,updated_at
  FROM notification_deliveries;
DROP TABLE notification_deliveries;
ALTER TABLE notification_deliveries_next RENAME TO notification_deliveries;
CREATE INDEX notification_deliveries_pending ON notification_deliveries(status,created_at);
