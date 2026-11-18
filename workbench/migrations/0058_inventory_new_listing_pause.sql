ALTER TABLE inventory_automatic_settings ADD COLUMN new_listings_enabled INTEGER NOT NULL DEFAULT 1
  CHECK (new_listings_enabled IN (0,1));

-- A policy change during API preflight must take effect before a CSV permit is created.
CREATE TRIGGER inventory_automatic_ordered_only_permit BEFORE UPDATE OF state ON inventory_replenishment_jobs
WHEN NEW.state='SUBMITTING' AND OLD.state='CLAIMED'
 AND EXISTS(SELECT 1 FROM inventory_automatic_jobs WHERE job_id=NEW.id)
 AND EXISTS(SELECT 1 FROM inventory_automatic_settings WHERE singleton=1 AND new_listings_enabled=0)
BEGIN
 SELECT CASE WHEN EXISTS(
   SELECT 1 FROM inventory_replenishment_rows r WHERE r.job_id=NEW.id AND r.outcome='PENDING' AND r.active=1
   AND NOT EXISTS(SELECT 1 FROM inventory_replenishment_eligibility q
     WHERE q.sku_key=json_remove(r.inventory_key,'$[3]','$[3]') AND q.ordered_scan_id IS NOT NULL)
 ) THEN RAISE(ABORT,'AUTOMATIC_NEW_LISTINGS_PAUSED') END;
END;
