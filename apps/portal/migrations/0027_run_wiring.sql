-- Which of a team's own functions the platform ran.
--
-- No 2026 repository says which function is its peak finder, so the platform
-- works it out by calling their functions and passing each one's real output
-- to the next. A score now rests on that inference, and an inference a team
-- cannot see is one they cannot correct. Keep it with the run.
--
-- Null for a repository that declared its own submission: there is nothing
-- inferred to show when a team told us where their code is.
ALTER TABLE runs ADD COLUMN wiring_json TEXT;
