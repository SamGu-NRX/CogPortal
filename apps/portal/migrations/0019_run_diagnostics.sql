-- The benchmark already explains what a submission got wrong ("embed_text
-- returned an array with 1 dimensions; expected a 2-D (rows, D) matrix"), and
-- the runner already sends those lines in the succeeded event. The portal was
-- dropping them, so a student whose adapter was subtly broken saw only a
-- number near chance and no reason. Keep them with the run.
ALTER TABLE runs ADD COLUMN diagnostics_json TEXT;
