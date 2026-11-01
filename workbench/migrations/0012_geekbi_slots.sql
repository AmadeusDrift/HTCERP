-- Retain original identifiers and ciphertext so slot 1 keeps its v1 encryption context.
ALTER TABLE connection_credentials RENAME TO connection_credentials_old;
DROP TRIGGER connection_credentials_reset_test;
CREATE TABLE connection_credentials (
  provider TEXT PRIMARY KEY CHECK (provider IN ('geekbi','geekbi-2','geekbi-3','geekbi-4','geekbi-5','openrouter','amazon')),
  version INTEGER NOT NULL CHECK (version = 1),
  nonce TEXT NOT NULL CHECK (length(nonce) = 16),
  ciphertext TEXT NOT NULL
);
INSERT INTO connection_credentials SELECT * FROM connection_credentials_old;
DROP TABLE connection_credentials_old;
CREATE TRIGGER connection_credentials_reset_test AFTER INSERT ON connection_credentials
BEGIN
  DELETE FROM connection_tests WHERE service = NEW.provider;
END;
ALTER TABLE usage_reservations ADD COLUMN credential_slot INTEGER NOT NULL DEFAULT 1 CHECK(credential_slot BETWEEN 1 AND 5);
