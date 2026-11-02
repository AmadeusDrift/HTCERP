CREATE TABLE assistant_messages (
 seq INTEGER PRIMARY KEY AUTOINCREMENT,
 run_id TEXT NOT NULL REFERENCES assistant_runs(id), id TEXT NOT NULL,
 message TEXT NOT NULL, intent TEXT NOT NULL CHECK(intent IN ('continue','new')),
 state TEXT NOT NULL CHECK(state IN ('pending','applied')),
 destination_run_id TEXT REFERENCES assistant_runs(id),
 created_at TEXT NOT NULL, applied_at TEXT,
 UNIQUE(run_id,id)
);
CREATE INDEX assistant_messages_pending ON assistant_messages(run_id,state,seq);
ALTER TABLE assistant_runs ADD COLUMN wake_requested INTEGER NOT NULL DEFAULT 0;
ALTER TABLE assistant_steps ADD COLUMN scope_version INTEGER NOT NULL DEFAULT 1;
CREATE TABLE assistant_report_versions (
 run_id TEXT NOT NULL REFERENCES assistant_runs(id), revision INTEGER NOT NULL,
 scope_version INTEGER NOT NULL, report_json TEXT NOT NULL, answer TEXT NOT NULL,
 created_at TEXT NOT NULL,
 PRIMARY KEY(run_id,revision)
);
INSERT INTO assistant_report_versions(run_id,revision,scope_version,report_json,answer,created_at)
SELECT r.id,r.version,r.scope_version,r.report_json,COALESCE(t.answer,''),r.updated_at
FROM assistant_runs r JOIN assistant_turns t ON t.conversation_id=r.conversation_id AND t.id=r.origin_turn_id
WHERE r.report_json IS NOT NULL;
