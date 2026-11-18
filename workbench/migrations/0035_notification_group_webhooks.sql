ALTER TABLE notification_groups ADD COLUMN webhook_nonce TEXT;
ALTER TABLE notification_groups ADD COLUMN webhook_ciphertext TEXT;
