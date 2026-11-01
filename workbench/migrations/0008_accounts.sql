CREATE TABLE accounts (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  role TEXT NOT NULL CHECK (role IN ('admin','operator','viewer')),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  salt TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  auth_version INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE account_sessions (
  token_hash TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  auth_version INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX account_session_expiry ON account_sessions(expires_at);
CREATE TABLE login_attempts (
  bucket TEXT PRIMARY KEY,
  window INTEGER NOT NULL,
  used INTEGER NOT NULL
);
CREATE INDEX login_attempt_window ON login_attempts(window);
