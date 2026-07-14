-- This value is GitHub's immutable numeric source repository ID, not the
-- template_sources table's text primary key. Make the distinction explicit.
ALTER TABLE teams RENAME COLUMN template_source_id TO template_source_repo_id;
