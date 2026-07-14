ALTER TABLE users ADD COLUMN github_id INTEGER;
CREATE UNIQUE INDEX idx_users_github_id ON users(github_id);
ALTER TABLE sessions ADD COLUMN oauth_token TEXT;
