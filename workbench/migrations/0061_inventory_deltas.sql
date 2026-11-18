CREATE TABLE inventory_delta_settings (
  singleton INTEGER PRIMARY KEY CHECK(singleton=1),
  enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)),
  replace_frequent_full_scans INTEGER NOT NULL DEFAULT 0
    CHECK(replace_frequent_full_scans IN (0,1))
);
INSERT INTO inventory_delta_settings(singleton) VALUES(1);
CREATE TABLE inventory_delta_cursors (
  seller TEXT NOT NULL, revision TEXT NOT NULL,
  lane TEXT NOT NULL CHECK(lane IN ('stock','orders')),
  watermark INTEGER NOT NULL, last_success_at INTEGER NOT NULL DEFAULT 0,
  tracked_rows INTEGER NOT NULL DEFAULT 0,
  lease_id TEXT NOT NULL, lease_until INTEGER NOT NULL,
  PRIMARY KEY(seller,revision,lane)
);
