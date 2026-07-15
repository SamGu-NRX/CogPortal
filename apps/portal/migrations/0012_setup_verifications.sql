CREATE TABLE setup_verifications (
  user_id TEXT NOT NULL REFERENCES users(id),
  team_id TEXT NOT NULL REFERENCES teams(id),
  step TEXT NOT NULL,
  verified_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, team_id, step)
);
