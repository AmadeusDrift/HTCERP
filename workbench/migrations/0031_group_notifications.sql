CREATE TABLE notification_groups (
  id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, webhook_key TEXT NOT NULL UNIQUE,
  enabled INTEGER NOT NULL CHECK(enabled IN (0,1)), webhook_hint TEXT
);
CREATE TABLE notification_routes (
  service TEXT PRIMARY KEY CHECK(service IN ('feedback','infringement')),
  group_id TEXT NOT NULL REFERENCES notification_groups(id), activated_at TEXT NOT NULL
);
CREATE TABLE notification_group_members (
  group_id TEXT NOT NULL REFERENCES notification_groups(id), account_id TEXT NOT NULL REFERENCES accounts(id),
  enabled INTEGER NOT NULL CHECK(enabled IN (0,1)), PRIMARY KEY(group_id,account_id)
);
CREATE TABLE notification_deliveries (
  id TEXT PRIMARY KEY, service TEXT NOT NULL CHECK(service IN ('feedback','infringement')),
  group_id TEXT NOT NULL REFERENCES notification_groups(id), account_id TEXT NOT NULL REFERENCES accounts(id),
  trial INTEGER NOT NULL DEFAULT 0 CHECK(trial IN (0,1)), content TEXT NOT NULL, image TEXT,
  phase TEXT NOT NULL DEFAULT 'text' CHECK(phase IN ('text','image')),
  status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','sending','sent','failed','unknown','cancelled')),
  attempts INTEGER NOT NULL DEFAULT 0, error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX notification_deliveries_pending ON notification_deliveries(status,created_at);
CREATE TABLE notification_webhook_rate (webhook_key TEXT PRIMARY KEY, minute INTEGER NOT NULL, used INTEGER NOT NULL);
CREATE TABLE notification_infringement_scan (
  seller TEXT PRIMARY KEY, through_ms INTEGER NOT NULL, lease TEXT, lease_until INTEGER, error TEXT
);
CREATE TABLE notification_infringements (
  seller TEXT NOT NULL, sku TEXT NOT NULL, asin TEXT, image TEXT, listed_at TEXT,
  fingerprint TEXT NOT NULL, changed_at TEXT NOT NULL, revision TEXT NOT NULL,
  PRIMARY KEY(seller,sku)
);
CREATE TABLE notification_infringement_events (
  id TEXT PRIMARY KEY, seller TEXT NOT NULL, sku TEXT NOT NULL, observed_at TEXT NOT NULL
);
CREATE INDEX notification_infringement_events_observed ON notification_infringement_events(seller,observed_at);
CREATE TRIGGER notification_infringement_added AFTER INSERT ON notification_infringements
WHEN NEW.fingerprint <> '[]'
BEGIN
  INSERT INTO notification_infringement_events VALUES(NEW.revision,NEW.seller,NEW.sku,NEW.changed_at);
END;
CREATE TRIGGER notification_infringement_changed AFTER UPDATE ON notification_infringements
WHEN NEW.revision <> OLD.revision AND NEW.fingerprint <> '[]'
BEGIN
  INSERT INTO notification_infringement_events VALUES(NEW.revision,NEW.seller,NEW.sku,NEW.changed_at);
END;
