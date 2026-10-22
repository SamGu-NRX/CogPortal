import assert from "node:assert/strict";
import { test } from "node:test";
import { heard, identityOf, leakedCells, runPositives } from "../../../tools/portal-real-journeys/journeys/answer-scan.mjs";

/*
 * The route matrix (tools/portal-real-journeys, s5-route-matrix) scans every
 * answer for planted private data. Its positive controls make several
 * requests each (a throwaway sign-in, a cohort join, a poll) and return one;
 * the scan has to read every answer the Worker gave, not only the returned
 * one (PR 114 review, 2026-10-22). The journey itself needs the full local
 * stack, so this checks the collection and the scan it uses, with requests
 * reported the way world.mjs's call() reports them.
 */

const CANARIES = [
  { name: "team A's run log", value: "rj-canary-a-run-log", allowed: ["studentA", "deviceA"] },
  { name: "studentA's setup token", value: "rj-canary-setup-token-a", allowed: ["studentA"] },
];

const world = () => ({
  who: {
    signedOut: {},
    studentA: { cookie: "session=rj-student-a" },
    deviceA: { bearer: "rj-device-a" },
  },
});

/** What world.mjs's call() does with an answer: report it, then return it. */
function answer(method: string, path: string, who: object | undefined, status: number, body: unknown) {
  const result = { status, text: JSON.stringify(body), json: body };
  heard({ method, path, who }, result);
  return result;
}

test("a canary in a positive control's setup answer is a leak, under the identity that asked", async () => {
  const controls = [
    [
      "POST /api/team/members",
      200,
      "studentA",
      async () => {
        const invitee = { cookie: "session=rj-throwaway-invitee" };
        answer("POST", "/api/cohorts/join", invitee, 200, { team: { log: "rj-canary-a-run-log" } });
        return answer("POST", "/api/team/members", { cookie: "session=rj-student-a" }, 200, { members: [] });
      },
    ],
    [
      "POST /api/activity/oauth/token",
      200,
      "activityA",
      async () => {
        answer("POST", "/api/activity/oauth/token", undefined, 200, { note: "rj-canary-setup-token-a" });
        return { status: 200 };
      },
    ],
  ];
  const { positives, cells } = await runPositives(controls, world());
  assert.deepEqual(leakedCells(cells, CANARIES), [
    { route: "POST /api/team/members [step POST /api/cohorts/join] [positive]", identity: "throwaway", status: 200, found: ["team A's run log"] },
    { route: "POST /api/activity/oauth/token [step POST /api/activity/oauth/token] [positive]", identity: "signedOut", status: 200, found: ["studentA's setup token"] },
  ]);
  assert.deepEqual(positives["POST /api/team/members"], { caller: "studentA", want: 200, got: 200, answer: undefined });
});

test("a step answer is judged against the world identity whose credentials sent it", async () => {
  const controls = [
    [
      "POST /api/v1/setup/check-off",
      200,
      "signedOut",
      async () => {
        answer("GET", "/api/v1/setup/state", { cookie: "session=rj-student-a" }, 200, { tokens: { clone: "rj-canary-setup-token-a" } });
        answer("GET", "/api/runs/run_a", { bearer: "rj-device-a" }, 200, { log: "rj-canary-a-run-log" });
        return answer("POST", "/api/v1/setup/check-off?t=x", undefined, 200, { ok: true });
      },
    ],
  ];
  const { cells } = await runPositives(controls, world());
  assert.deepEqual(
    cells.map((cell) => [cell.key, cell.identity]),
    [
      ["POST /api/v1/setup/check-off", "signedOut"],
      ["POST /api/v1/setup/check-off [step GET /api/v1/setup/state]", "studentA"],
      ["POST /api/v1/setup/check-off [step GET /api/runs/run_a]", "deviceA"],
    ],
  );
  assert.deepEqual(leakedCells(cells, CANARIES), []);
});

test("a control's own answer is one cell, and a control that throws still has its steps scanned", async () => {
  const controls = [
    ["GET /api/runs", 200, "studentA", async () => answer("GET", "/api/runs", { cookie: "session=rj-student-a" }, 200, [])],
    [
      "POST /api/github/connect",
      200,
      "rj-m-pos-connect",
      async () => {
        answer("POST", "/api/dev/login", undefined, 200, { leaked: "rj-canary-a-run-log" });
        throw new Error("connect answered 500");
      },
    ],
  ];
  const { positives, cells } = await runPositives(controls, world());
  assert.equal(cells.filter((cell) => cell.key.startsWith("GET /api/runs")).length, 1);
  assert.deepEqual(positives["POST /api/github/connect"], { caller: "rj-m-pos-connect", want: 200, got: 0, answer: "connect answered 500" });
  assert.deepEqual(
    leakedCells(cells, CANARIES).map((leak) => leak.route),
    ["POST /api/github/connect [step POST /api/dev/login] [positive]"],
  );
});

test("answers outside a positive control are not collected", async () => {
  answer("GET", "/api/runs/run_a", undefined, 200, { log: "rj-canary-a-run-log" });
  const { cells } = await runPositives([["GET /api/session", 200, "studentA", async () => ({ status: 200, text: "{}" })]], world());
  assert.deepEqual(cells.map((cell) => cell.key), ["GET /api/session"]);
});

test("identityOf names no world identity for missing or unknown credentials", () => {
  const w = world();
  assert.equal(identityOf(w, undefined), "signedOut");
  assert.equal(identityOf(w, {}), "signedOut");
  assert.equal(identityOf(w, { cookie: "session=rj-someone-else" }), "throwaway");
  assert.equal(identityOf(w, { cookie: "session=rj-student-a" }), "studentA");
});
