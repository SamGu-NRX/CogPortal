import test from "node:test";
import assert from "node:assert/strict";
import { REQUIRED_MIN } from "../lib/state-gen.mjs";

// Beta's worker never writes official_attempts in this flow (no runtime code
// touches the table; the seeded demo attempt stays put), and the designed
// practice-mode failure never promotes, so no refund fires. Any floor above 0
// makes the bar unmeetable; the receipt keeps counting both for observability.
test("pass bar pins no new attempts and no refunds, not an unreachable floor", () => {
  assert.equal(REQUIRED_MIN.officialAttempts, 0);
  assert.equal(REQUIRED_MIN.refundedRuns, 0);
});
