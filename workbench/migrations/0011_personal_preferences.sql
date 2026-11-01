CREATE TABLE personal_preferences (
  actor_id TEXT PRIMARY KEY,
  view TEXT NOT NULL CHECK (view IN ('table', 'grid')),
  page_size INTEGER NOT NULL CHECK (page_size IN (10, 20, 50, 100))
);

CREATE TABLE personal_presets (
  actor_id TEXT NOT NULL,
  id TEXT NOT NULL,
  name TEXT NOT NULL COLLATE NOCASE CHECK (length(name) BETWEEN 1 AND 40),
  filters_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (actor_id, id),
  UNIQUE (actor_id, name)
);
