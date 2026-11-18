DROP TRIGGER connection_credentials_reset_test;
ALTER TABLE connection_credentials RENAME TO connection_credentials_before_wecom;
CREATE TABLE connection_credentials (
  provider TEXT PRIMARY KEY CHECK(provider IN ('geekbi','geekbi-2','geekbi-3','geekbi-4','geekbi-5','openrouter','amazon','wecom')),
  version INTEGER NOT NULL CHECK(version=1),
  nonce TEXT NOT NULL CHECK(length(nonce)=16),
  ciphertext TEXT NOT NULL
);
INSERT INTO connection_credentials SELECT * FROM connection_credentials_before_wecom;
DROP TABLE connection_credentials_before_wecom;
CREATE TRIGGER connection_credentials_reset_test AFTER INSERT ON connection_credentials
BEGIN
  DELETE FROM connection_tests WHERE service=NEW.provider;
END;
