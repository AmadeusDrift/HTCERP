CREATE TABLE title_audit_store(singleton INTEGER PRIMARY KEY CHECK(singleton=1),seller TEXT NOT NULL,enabled INTEGER NOT NULL DEFAULT 0);
CREATE TABLE title_audit_runs(id TEXT PRIMARY KEY,seller TEXT NOT NULL,started TEXT NOT NULL,finished TEXT,status TEXT NOT NULL,error TEXT,version TEXT NOT NULL);
CREATE UNIQUE INDEX title_audit_active ON title_audit_runs(seller) WHERE status='running';
CREATE TABLE title_audit_rows(run TEXT NOT NULL REFERENCES title_audit_runs(id) ON DELETE CASCADE,sku TEXT NOT NULL,asin TEXT,title TEXT NOT NULL,verdict TEXT NOT NULL,disposition TEXT NOT NULL,evidence TEXT NOT NULL,hits TEXT NOT NULL,PRIMARY KEY(run,sku));
CREATE INDEX title_audit_filter ON title_audit_rows(run,verdict,disposition);
CREATE TABLE title_audit_terms(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT NOT NULL,name_key TEXT UNIQUE NOT NULL,family TEXT NOT NULL,aliases TEXT NOT NULL,reason TEXT NOT NULL,created_by TEXT NOT NULL,created_at TEXT NOT NULL);
