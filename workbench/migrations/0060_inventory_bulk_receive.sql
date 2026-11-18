ALTER TABLE inventory_devices ADD COLUMN bulk_seen_at INTEGER;
ALTER TABLE inventory_replenishment_rows ADD COLUMN reconcile_after INTEGER NOT NULL DEFAULT 0;
CREATE INDEX inventory_replenishment_bulk_reconcile
  ON inventory_replenishment_rows(job_id,reconcile_after,id)
  WHERE active=1 AND outcome IN ('SUCCEEDED','UNKNOWN');
