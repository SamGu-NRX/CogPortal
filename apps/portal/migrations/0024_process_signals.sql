-- One row per team, holding the last computed process signals (stage
-- footprint, first light, boundary churn, ownership breadth) so a page load
-- does not re-fetch and re-derive up to 300 commits from GitHub every time.
--
-- `signals_json` and `history_quality` are recomputed together and always
-- replaced as a pair (see worker/routes/team.ts): `history_quality` is
-- pulled out of the JSON blob into its own column only so a future query
-- can filter teams by it (e.g. "which teams still have no usable history")
-- without parsing JSON in SQL.
CREATE TABLE team_process_signals (
  team_id TEXT PRIMARY KEY REFERENCES teams(id),
  computed_at INTEGER NOT NULL,
  signals_json TEXT NOT NULL,
  history_quality TEXT NOT NULL
);
