-- The sweep the scorer computed, as JSON, so the run page can draw the curve
-- the course teaches rather than only the single number at its right end.
--
-- Nullable and defaulted: every run scored before this column existed keeps
-- working, and a benchmark whose difficulty has no natural knob never fills
-- it. The run page shows the metric grid alone in both cases.
ALTER TABLE runs ADD COLUMN sweep_json TEXT;
