import assert from "node:assert/strict";
import { test } from "node:test";
import {
  parseRunIdParam,
  parseSurfaceIdParam,
  runSurfaceStreamPath,
} from "../src/lib/run-page-params.ts";

const RUN_ID_MISSING =
  "This run link is missing its run id. Open the run again from the dashboard.";
const SURFACE_ID_MISSING =
  "This surface link is missing its surface id. Open the surface again from the dashboard.";
const SURFACE_ID_MALFORMED =
  "This surface link is malformed; surface ids look like surface_ followed by 20 hex characters. Open the surface again from the dashboard.";

const VALID_SURFACE_ID = "surface_0123456789abcdef0123";

test("parseRunIdParam accepts run ids in the seeded demo shape", () => {
  assert.deepEqual(parseRunIdParam("run_demo_p1"), {
    ok: true,
    id: "run_demo_p1",
  });
});

test("parseRunIdParam trims surrounding whitespace from a pasted link", () => {
  assert.deepEqual(parseRunIdParam("  run_demo_p1  "), {
    ok: true,
    id: "run_demo_p1",
  });
});

test("parseRunIdParam rejects empty, missing, and blank params with the exact message", () => {
  assert.deepEqual(parseRunIdParam(""), {
    ok: false,
    reason: RUN_ID_MISSING,
  });
  assert.deepEqual(parseRunIdParam(undefined), {
    ok: false,
    reason: RUN_ID_MISSING,
  });
  assert.deepEqual(parseRunIdParam("   "), {
    ok: false,
    reason: RUN_ID_MISSING,
  });
});

test("parseSurfaceIdParam accepts the contract shape: surface_ plus 20 lowercase hex", () => {
  assert.deepEqual(parseSurfaceIdParam(VALID_SURFACE_ID), {
    ok: true,
    id: VALID_SURFACE_ID,
  });
});

test("parseSurfaceIdParam trims surrounding whitespace", () => {
  assert.deepEqual(parseSurfaceIdParam(`  ${VALID_SURFACE_ID}  `), {
    ok: true,
    id: VALID_SURFACE_ID,
  });
});

test("parseSurfaceIdParam rejects a missing id with the exact message", () => {
  assert.deepEqual(parseSurfaceIdParam(""), {
    ok: false,
    reason: SURFACE_ID_MISSING,
  });
  assert.deepEqual(parseSurfaceIdParam(undefined), {
    ok: false,
    reason: SURFACE_ID_MISSING,
  });
  assert.deepEqual(parseSurfaceIdParam("   "), {
    ok: false,
    reason: SURFACE_ID_MISSING,
  });
});

test("parseSurfaceIdParam rejects malformed shapes with the exact message", () => {
  // wrong prefix entirely
  assert.deepEqual(parseSurfaceIdParam("run_0123456789abcdef0123"), {
    ok: false,
    reason: SURFACE_ID_MALFORMED,
  });
  // 19 hex characters, one short
  assert.deepEqual(parseSurfaceIdParam("surface_0123456789abcdef012"), {
    ok: false,
    reason: SURFACE_ID_MALFORMED,
  });
  // 21 hex characters, one long
  assert.deepEqual(parseSurfaceIdParam("surface_0123456789abcdef01234"), {
    ok: false,
    reason: SURFACE_ID_MALFORMED,
  });
  // uppercase hex never matches the wire contract
  assert.deepEqual(parseSurfaceIdParam("surface_0123456789ABCDEF0123"), {
    ok: false,
    reason: SURFACE_ID_MALFORMED,
  });
  // right length, not hex
  assert.deepEqual(parseSurfaceIdParam("surface_zzzzzzzzzzzzzzzzzzzz"), {
    ok: false,
    reason: SURFACE_ID_MALFORMED,
  });
});

test("runSurfaceStreamPath builds the stream endpoint and encodes the id", () => {
  assert.equal(
    runSurfaceStreamPath(VALID_SURFACE_ID),
    `/api/run-surfaces/${VALID_SURFACE_ID}/stream`,
  );
  assert.equal(
    runSurfaceStreamPath("a/b c"),
    "/api/run-surfaces/a%2Fb%20c/stream",
  );
});
