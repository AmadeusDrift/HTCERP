-- An explicit balance refusal excludes this revision for the business day. A missing receipt retains its reservation.
ALTER TABLE usage_reservations ADD COLUMN credential_revision TEXT;
ALTER TABLE usage_reservations ADD COLUMN balance_refused INTEGER NOT NULL DEFAULT 0 CHECK(balance_refused IN (0,1));
CREATE INDEX usage_geekbi_refusals ON usage_reservations(business_date,credential_slot,credential_revision) WHERE balance_refused=1;
