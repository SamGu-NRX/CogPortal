-- Keep the latest CLI result for each setup step. NULL means the latest result
-- passed; a code means the latest result failed.
ALTER TABLE setup_verifications ADD COLUMN failure_code TEXT;
