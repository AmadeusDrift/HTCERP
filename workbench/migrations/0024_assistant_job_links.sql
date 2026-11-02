CREATE TABLE assistant_proposals (
 id TEXT PRIMARY KEY,run_id TEXT NOT NULL REFERENCES assistant_runs(id),scope_version INTEGER NOT NULL,
 action_key TEXT NOT NULL,spec_json TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN ('pending','confirmed','rejected','expired','invalidated')),
 expires_at TEXT NOT NULL,created_at TEXT NOT NULL,confirmed_at TEXT,confirmation_token TEXT,
 UNIQUE(run_id,scope_version,action_key)
);
CREATE TABLE assistant_job_links (
 id TEXT PRIMARY KEY,run_id TEXT NOT NULL REFERENCES assistant_runs(id),proposal_id TEXT NOT NULL REFERENCES assistant_proposals(id),
 scope_version INTEGER NOT NULL,action_key TEXT NOT NULL,request_id TEXT NOT NULL UNIQUE,job_id TEXT UNIQUE REFERENCES job_runs(id),
 operation TEXT NOT NULL,input_json TEXT NOT NULL,allocated_points INTEGER NOT NULL CHECK(allocated_points>=0),
 allocated_micros INTEGER NOT NULL CHECK(allocated_micros>=0),calls_limit INTEGER NOT NULL CHECK(calls_limit>=0),calls_used INTEGER NOT NULL DEFAULT 0,
 state TEXT NOT NULL CHECK(state IN ('pending','submitted','settled','uncertain')),business_date TEXT NOT NULL,children_materialized INTEGER NOT NULL DEFAULT 0,
 created_at TEXT NOT NULL,updated_at TEXT NOT NULL,wait_until TEXT NOT NULL,result_json TEXT,summary TEXT NOT NULL DEFAULT '',
 UNIQUE(run_id,scope_version,action_key)
);
CREATE INDEX assistant_links_run ON assistant_job_links(run_id,state);
ALTER TABLE usage_reservations ADD COLUMN assistant_link_id TEXT REFERENCES assistant_job_links(id);
CREATE INDEX usage_assistant_link ON usage_reservations(assistant_link_id,unit);
CREATE TRIGGER assistant_close_allocations AFTER UPDATE OF status ON assistant_runs
WHEN NEW.status IN ('cancelled','partial','failed') BEGIN
 UPDATE job_runs SET status=CASE WHEN status IN ('running','pausing') THEN 'cancelling' ELSE 'cancelled' END,
 summary='调查已停止，停止新请求；在途费用继续归档结算。'
 WHERE id IN (SELECT job_id FROM assistant_job_links WHERE run_id=NEW.id) AND status IN ('queued','running','paused','pausing');
 UPDATE assistant_job_links SET state='settled',summary=CASE WHEN summary='' THEN '调查已停止，未使用分配已释放；已发预留继续保留。' ELSE summary END
 WHERE run_id=NEW.id AND state IN ('pending','submitted','uncertain');
END;
CREATE TRIGGER assistant_pause_children AFTER UPDATE OF status ON assistant_runs
WHEN NEW.status IN ('pausing','paused') BEGIN
 UPDATE job_runs SET status=CASE WHEN status='running' THEN 'pausing' ELSE 'paused' END
 WHERE id IN (SELECT job_id FROM assistant_job_links WHERE run_id=NEW.id AND state='submitted') AND status IN ('running','queued');
END;
