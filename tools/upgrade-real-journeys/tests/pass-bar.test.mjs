import test from "node:test";
import assert from "node:assert/strict";
import { REQUIRED_MIN } from "../lib/state-gen.mjs";

// The suite's designed platform-failure run refunds its official attempt
// outright (migration 0029), so official_attempts goes 1 -> 0 during generate.
// A minimum above 0 re-makes the bar unmeetable; the refund itself is what the
// bar must pin.
test("pass bar pins the attempt refund, not an unreachable attempts floor", () => {
  assert.equal(REQUIRED_MIN.officialAttempts, 0);
  assert.equal(REQUIRED_MIN.refundedRuns, 1);
});
