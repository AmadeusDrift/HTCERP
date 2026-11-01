CREATE TABLE assistant_conversations (
  id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id),
  title TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX assistant_history ON assistant_conversations(account_id,updated_at DESC,id);
CREATE TABLE assistant_turns (
  conversation_id TEXT NOT NULL REFERENCES assistant_conversations(id), id TEXT NOT NULL,
  question TEXT NOT NULL, context_json TEXT NOT NULL, image_url TEXT,
  answer TEXT, issue TEXT, created_at TEXT NOT NULL,
  PRIMARY KEY(conversation_id,id)
);
CREATE INDEX assistant_transcript ON assistant_turns(conversation_id,created_at DESC);
CREATE TRIGGER assistant_activity AFTER INSERT ON assistant_turns BEGIN
  UPDATE assistant_conversations SET updated_at=NEW.created_at WHERE id=NEW.conversation_id;
END;
