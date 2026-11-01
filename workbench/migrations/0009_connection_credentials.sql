CREATE TABLE connection_credentials (
  provider TEXT PRIMARY KEY CHECK (provider IN ('geekbi','openrouter','amazon')),
  version INTEGER NOT NULL CHECK (version = 1),
  nonce TEXT NOT NULL CHECK (length(nonce) = 16),
  ciphertext TEXT NOT NULL
);

-- Each full replacement inserts a freshly encrypted record, invalidating the prior test atomically.
CREATE TRIGGER connection_credentials_reset_test AFTER INSERT ON connection_credentials
BEGIN
  DELETE FROM connection_tests WHERE service = NEW.provider;
END;
