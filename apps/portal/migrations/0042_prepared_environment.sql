ALTER TABLE runs ADD COLUMN prepared_environment_json TEXT;
ALTER TABLE benchmarks ADD COLUMN sandbox_contract INTEGER
  CONSTRAINT benchmarks_sandbox_contract_positive
  CHECK (sandbox_contract IS NULL OR (typeof(sandbox_contract) = 'integer' AND sandbox_contract > 0));

-- PR8's existing decoders use contract 1, including Language's six-case decoder.
-- Dependent decoder changes must advance their own catalog contract explicitly.
-- No historical snapshot gains provisioning evidence from this catalog seed.
UPDATE benchmarks SET sandbox_contract = 1
WHERE id IN ('audio-identification', 'language-search', 'vision-recognition', 'vision-clustering');
