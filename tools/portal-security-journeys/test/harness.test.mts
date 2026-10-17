/**
 * Focused tests for the harness pieces review found broken in the pre-merge
 * session: a skipped journey erasing the checks collected before the skip,
 * and the device helper reading a field the wire contract never grants.
 *
 * Run with `pnpm --filter @cogworks/portal-security-journeys test` — no stack
 * required; the only network is a stubbed global fetch.
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { Api, linkDevice } from "../src/lib/client.mts";
import { SkipJourney, skipJourneyResult, type Check } from "../src/lib/framework.mts";

const journey = { id: "j-test", title: "test journey", fixedInput: "none" };

describe("SkipJourney carries and preserves completed checks", () => {
  it("a skip whose completed checks contain a failure is status=fail, not skip", () => {
    const checks: Check[] = [
      { name: "ran and passed", ok: true },
      { name: "ran and failed", ok: false, detail: "HTTP 200 leaked the token" },
    ];
    const result = skipJourneyResult(journey, new SkipJourney("late arm unexercisable", checks), 12);
    assert.equal(result.status, "fail");
    assert.equal(result.checks.length, 2);
    assert.equal(result.skippedBecause, "late arm unexercisable");
    assert.equal(result.ms, 12);
  });

  it("a skip whose completed checks all pass stays status=skip", () => {
    const result = skipJourneyResult(journey, new SkipJourney("late arm unexercisable", [{ name: "ran and passed", ok: true }]), 5);
    assert.equal(result.status, "skip");
    assert.equal(result.checks.length, 1);
  });

  it("a skip without checks keeps the old shape (no checks, status=skip)", () => {
    const result = skipJourneyResult(journey, new SkipJourney("stack never booted"), 3);
    assert.equal(result.status, "skip");
    assert.deepEqual(result.checks, []);
  });
});

describe("linkDevice reads the granted token from the wire contract", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("returns body.token from {status:'authorized', token} — a missed grant is unrecoverable, the next poll is 410", async () => {
    const deviceCode = "d".repeat(64);
    let grants = 0;
    globalThis.fetch = (async (url: unknown, init?: unknown) => {
      const path = String(url);
      const body = String((init as { body?: string } | undefined)?.body ?? "");
      if (path.endsWith("/api/v1/cli/device/start")) return jsonRes(200, { deviceCode, userCode: "AAA-AAA-AAA" });
      if (path.endsWith("/api/v1/cli/device/approve")) return jsonRes(200, { ok: true });
      if (path.endsWith("/api/v1/cli/device/token") && body.includes(deviceCode)) {
        // The real endpoint grants exactly one token per code: the second
        // poll gets 410, so a reader that misses `token` never recovers.
        grants++;
        return grants === 1 ? jsonRes(200, { status: "authorized", token: "cog_test_token" }) : jsonRes(410, { error: "gone" });
      }
      return jsonRes(500, { error: `unexpected ${path}` });
    }) as typeof fetch;

    const token = await linkDevice(new Api("http://127.0.0.1:1"), "unit-box");
    assert.ok(!(token instanceof Error), `linkDevice errored: ${String(token)}`);
    assert.equal(token, "cog_test_token");
  });
});

function jsonRes(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
