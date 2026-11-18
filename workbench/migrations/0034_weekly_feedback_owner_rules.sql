CREATE TABLE IF NOT EXISTS weekly_feedback_owner_rules (
  seller TEXT NOT NULL,
  marketplace TEXT NOT NULL,
  match_type TEXT NOT NULL CHECK(match_type IN ('prefix','prefix_suffix','contains_suffix')),
  pattern TEXT NOT NULL CHECK(length(pattern)>0),
  priority INTEGER NOT NULL,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  configured_by TEXT NOT NULL REFERENCES accounts(id),
  PRIMARY KEY(seller,marketplace,match_type,pattern)
);
