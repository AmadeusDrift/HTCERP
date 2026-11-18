ALTER TABLE title_audit_runs ADD COLUMN scope TEXT NOT NULL DEFAULT 'full' CHECK(scope IN ('full','haul'));
ALTER TABLE title_audit_runs ADD COLUMN window_start_ms INTEGER;
ALTER TABLE title_audit_runs ADD COLUMN window_end_ms INTEGER;
DROP INDEX title_audit_active;
CREATE UNIQUE INDEX title_audit_active ON title_audit_runs(seller,scope) WHERE status='running';
CREATE INDEX title_audit_runs_scope ON title_audit_runs(seller,scope,started DESC);
