CREATE TABLE notification_infringement_team_mentions (
  team TEXT PRIMARY KEY NOT NULL,
  account_id TEXT NOT NULL REFERENCES accounts(id)
);
