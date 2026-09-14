-- Language now decodes nine cases, including the three retrieval rewrites
-- absent from contract 1's six-case grid. The saved decoder fixture proves
-- those snapshots cannot supply the current controller's positional outputs.
-- For a running deployment, follow 0042's admission-pause and drain sequence
-- before enabling this contract alongside the matching runner/image.
UPDATE benchmarks SET sandbox_contract = 2
WHERE id = 'language-search';
