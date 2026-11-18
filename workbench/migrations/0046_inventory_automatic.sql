-- Execution remains disabled until an administrator explicitly enables it.
CREATE TABLE inventory_automatic_settings(singleton INTEGER PRIMARY KEY CHECK(singleton=1), enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN(0,1)),interval_minutes INTEGER NOT NULL DEFAULT 60,updated_at INTEGER NOT NULL DEFAULT 0,activated_after INTEGER);
INSERT INTO inventory_automatic_settings VALUES(1,0,60,0,NULL);
CREATE TABLE inventory_automatic_generations(generation TEXT PRIMARY KEY REFERENCES inventory_source_runs(id),seller TEXT NOT NULL,cursor TEXT NOT NULL DEFAULT '',state TEXT NOT NULL DEFAULT 'SEEDING' CHECK(state IN('SEEDING','COMPLETE')),updated_at INTEGER NOT NULL);
CREATE TABLE inventory_automatic_candidates(generation TEXT NOT NULL REFERENCES inventory_source_runs(id),inventory_key TEXT NOT NULL,PRIMARY KEY(generation,inventory_key));
CREATE TABLE inventory_automatic_scans(scan_id TEXT PRIMARY KEY REFERENCES inventory_replenishment_scans(id),generation TEXT NOT NULL REFERENCES inventory_source_runs(id));
CREATE INDEX inventory_automatic_scan_generation ON inventory_automatic_scans(generation);
CREATE INDEX inventory_demand_scan ON inventory_replenishment_demands(scan_id);
CREATE INDEX inventory_eligibility_order_scan ON inventory_replenishment_eligibility(ordered_scan_id);
CREATE INDEX inventory_eligibility_new_scan ON inventory_replenishment_eligibility(new_listing_scan_id);
CREATE TABLE inventory_automatic_jobs(job_id TEXT PRIMARY KEY REFERENCES inventory_replenishment_jobs(id),seller TEXT NOT NULL,generation TEXT NOT NULL REFERENCES inventory_source_runs(id),connection_revision TEXT NOT NULL,credential_stamp TEXT NOT NULL,scope_json TEXT NOT NULL,device_id TEXT NOT NULL,created_at INTEGER NOT NULL,receipt_event_id TEXT,reconcile_at INTEGER NOT NULL DEFAULT 0);
CREATE INDEX inventory_automatic_device ON inventory_automatic_jobs(device_id,receipt_event_id);
CREATE TABLE inventory_automatic_events(job_id TEXT NOT NULL REFERENCES inventory_automatic_jobs(job_id),event_id TEXT NOT NULL,digest TEXT NOT NULL,payload_json TEXT NOT NULL,received_at INTEGER NOT NULL,archive_key TEXT,applied INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(job_id,event_id));
-- Every permit is fenced within its state transition, including races during API preflight.
CREATE TRIGGER inventory_automatic_permit BEFORE UPDATE OF state ON inventory_replenishment_jobs
WHEN NEW.state='SUBMITTING' AND OLD.state='CLAIMED' AND EXISTS(SELECT 1 FROM inventory_automatic_jobs WHERE job_id=NEW.id)
BEGIN
 SELECT CASE WHEN NOT EXISTS(
 SELECT 1 FROM inventory_automatic_jobs a JOIN inventory_automatic_settings s ON s.singleton=1 AND s.enabled=1
 JOIN inventory_source_runs run ON run.id=a.generation AND run.state='COMPLETE' AND run.started_at>s.activated_after
 JOIN inventory_automatic_generations g ON g.generation=a.generation AND g.state='COMPLETE'
 JOIN inventory_source_current current ON current.generation=a.generation AND current.seller=a.seller
 JOIN inventory_executors e ON e.scope_json=a.scope_json AND e.device_id=a.device_id
 JOIN inventory_devices d ON d.id=a.device_id AND d.scope_json=a.scope_json AND d.revoked_at IS NULL
 JOIN title_audit_store t ON t.singleton=1 AND t.seller=a.seller
 WHERE a.job_id=NEW.id AND a.credential_stamp=COALESCE((SELECT json_array(version,nonce,ciphertext) FROM connection_credentials WHERE provider='amazon'),'null')
 AND NOT EXISTS(SELECT 1 FROM inventory_live_trials l WHERE l.ended_at IS NULL AND l.scope_json=a.scope_json)
 ) THEN RAISE(ABORT,'AUTOMATIC_PERMIT_DISABLED_OR_CHANGED') END;
END;
CREATE TRIGGER inventory_manual_permit BEFORE UPDATE OF state ON inventory_replenishment_jobs
WHEN NEW.state='SUBMITTING' AND OLD.state='CLAIMED' AND EXISTS(SELECT 1 FROM inventory_live_jobs WHERE job_id=NEW.id)
BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM inventory_automatic_jobs a JOIN inventory_replenishment_jobs j ON j.id=a.job_id WHERE j.scope=NEW.scope AND a.receipt_event_id IS NULL AND j.state NOT IN('EXPIRED','SKIPPED')) THEN RAISE(ABORT,'AUTOMATIC_JOB_UNACKNOWLEDGED') END;
END;

CREATE TRIGGER inventory_manual_start BEFORE INSERT ON inventory_live_trials
BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM inventory_automatic_jobs a JOIN inventory_replenishment_jobs j ON j.id=a.job_id WHERE a.scope_json=NEW.scope_json AND a.receipt_event_id IS NULL AND j.state NOT IN('EXPIRED','SKIPPED')) THEN RAISE(ABORT,'AUTOMATIC_JOB_UNACKNOWLEDGED') END;
END;
