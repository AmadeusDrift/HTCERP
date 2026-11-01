CREATE TABLE assistant_runs (
 id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id),
 conversation_id TEXT NOT NULL, origin_turn_id TEXT NOT NULL,
 goal TEXT NOT NULL, context_json TEXT NOT NULL, scope_version INTEGER NOT NULL DEFAULT 1,
 policy_version TEXT NOT NULL DEFAULT 'cached-investigation-v1',
 status TEXT NOT NULL CHECK(status IN ('queued','running','waiting_jobs','awaiting_confirmation','awaiting_input','pausing','paused','cancelling','cancelled','succeeded','partial','failed')),
 limits_json TEXT NOT NULL, model_steps INTEGER NOT NULL DEFAULT 0, tool_steps INTEGER NOT NULL DEFAULT 0,
 active_ms INTEGER NOT NULL DEFAULT 0, attempt INTEGER NOT NULL DEFAULT 1,
 version INTEGER NOT NULL DEFAULT 1, workflow_started INTEGER NOT NULL DEFAULT 0,
 lease_token TEXT, lease_until INTEGER, report_json TEXT, summary TEXT NOT NULL DEFAULT '',
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 UNIQUE(conversation_id,origin_turn_id),
 FOREIGN KEY(conversation_id,origin_turn_id) REFERENCES assistant_turns(conversation_id,id)
);
CREATE INDEX assistant_runs_owner ON assistant_runs(account_id,updated_at DESC);
CREATE TABLE assistant_steps (
 run_id TEXT NOT NULL REFERENCES assistant_runs(id), seq INTEGER NOT NULL,
 action_key TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('model','tool')),
 name TEXT NOT NULL, input_json TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('pending','sending','completed','uncertain')),
 result_json TEXT, evidence_ref TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 PRIMARY KEY(run_id,seq), UNIQUE(run_id,action_key)
);
ALTER TABLE usage_reservations ADD COLUMN assistant_run_id TEXT REFERENCES assistant_runs(id);
CREATE INDEX usage_assistant ON usage_reservations(assistant_run_id,unit);
