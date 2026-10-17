import test from "node:test";
import assert from "node:assert/strict";
import { noBenchmarkInstalledError } from "../lib/state-gen.mjs";

// The week-probe loop rejects each candidate week with a recorded quirk. When
// no week installs and checks on the host, the thrown error must carry those
// reasons - a bare "none worked" turns a diagnosable host problem into a dead
// end (regression: the first rerun failed all three weeks and the error named
// none of them).
test("the no-benchmark error carries every week's rejection reason", () => {
  const error = noBenchmarkInstalledError([
    "week1: benchmark install or check failed on this host (exit 2 | benchmarkLoadable: false)",
    "week2: benchmark install or check failed on this host (requires-python <3.13)",
  ]);
  assert.match(error.message, /^no public week benchmark installed and passed `cogworks check` on this host/);
  assert.match(error.message, /week1:.*benchmarkLoadable: false/);
  assert.match(error.message, /week2:.*requires-python/);
});

test("with no quirks recorded the error keeps its bare form", () => {
  assert.equal(
    noBenchmarkInstalledError([]).message,
    "no public week benchmark installed and passed `cogworks check` on this host",
  );
});
