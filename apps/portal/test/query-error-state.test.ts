import assert from "node:assert/strict";
import { test } from "node:test";
import { API_ERROR_CODES } from "@cogworks/contracts/schema";
import { ApiRequestError } from "../src/lib/api.ts";
import { queryErrorState } from "../src/lib/query-error-state.ts";

/**
 * QueryError used to render one panel for every failure: tone "alert",
 * label "COULD NOT LOAD", and a "Try again" button even on a 404, where a
 * second request returns the same 404. These assert the grouping by what the
 * student can do, not by which code arrived.
 *
 * The mapping is tested as a function rather than by mounting QueryError
 * because the test runner is `tsx --test` with no DOM, and tsx does not
 * resolve the "@/" path alias at runtime, which QueryError imports through.
 * Panel and EmptyState render below, where imports are relative.
 */

test("a request that never left the browser says nothing was lost", () => {
  const state = queryErrorState(new ApiRequestError("network", "unused", 0));

  assert.equal(state.kind, "unreachable");
  assert.equal(state.retry, true);
  // Detector red is for a fault we can see. With status 0 the portal saw
  // nothing, so claiming a fault would overstate what it knows.
  assert.equal(state.tone, "default");
  assert.match(state.message, /never reached the portal, so nothing was lost/);
});

test("a missing record offers a way back and no retry", () => {
  const state = queryErrorState(
    new ApiRequestError("not_found", "Run not found.", 404),
  );

  assert.equal(state.kind, "missing");
  assert.equal(state.retry, false);
  assert.deepEqual(state.link, { to: "/", text: "Back to start" });
});

test("a missing record is an absence, not a fault", () => {
  const state = queryErrorState(
    new ApiRequestError("not_found", "Run surface not found.", 404),
  );

  // NotFound.tsx already renders a 404 as an EmptyState. An API 404 that
  // rendered as an alert panel made the same situation look like two.
  assert.equal(state.presentation, "empty");
  assert.equal(state.tone, "default");
});

test("a 404 is read from the status even when the code disagrees", () => {
  // worker/routes/dashboard.ts:39 throws 404 with the code "invalid_request"
  // for a missing benchmark. Branching on the code alone would call that a
  // server fault and offer a retry that cannot succeed.
  const state = queryErrorState(
    new ApiRequestError("invalid_request", "Active benchmark not found.", 404),
  );

  assert.equal(state.kind, "missing");
  assert.equal(state.retry, false);
});

test("an expired session sends the student to sign in, not to a retry", () => {
  const state = queryErrorState(
    new ApiRequestError("unauthorized", "Sign in to continue.", 401),
  );

  assert.equal(state.kind, "signin");
  assert.equal(state.retry, false);
  assert.equal(state.link?.to, "/signin");
});

test("a missing onboarding step names the step, not the failure", () => {
  const noCohort = queryErrorState(
    new ApiRequestError("no_cohort", "Join a cohort first.", 403),
  );
  const noTeam = queryErrorState(
    new ApiRequestError("no_team", "Connect a repository to continue.", 403),
  );

  assert.equal(noCohort.kind, "elsewhere");
  assert.equal(noCohort.link?.to, "/join");
  assert.equal(noTeam.kind, "elsewhere");
  assert.equal(noTeam.link?.to, "/connect");
  // nextStagePath in App.tsx computes these same destinations for a fresh
  // mount; this covers a session that loses the stage after mounting.
  for (const state of [noCohort, noTeam]) assert.equal(state.retry, false);
});

test("a server fault keeps the route's own sentence and adds the next step", () => {
  const state = queryErrorState(
    new ApiRequestError(
      "provider_unconfigured",
      "The request could not be completed by the configured backend.",
      500,
    ),
  );

  assert.equal(state.kind, "fault");
  assert.equal(state.tone, "alert");
  assert.equal(state.retry, true);
  assert.match(state.message, /configured backend/);
  assert.match(state.nextStep ?? "", /tell a TA/);
});

test("an unreadable error body is a fault the portal admits to", () => {
  // lib/api.ts falls back to "unknown" when a non-ok body fails the contract.
  const unknown = queryErrorState(
    new ApiRequestError("unknown", "The portal returned an unexpected error (502).", 502),
  );
  // A thrown Zod error from a 200 body that does not match its schema.
  const nonApi = queryErrorState(new Error("invalid_type"));

  assert.equal(unknown.kind, "fault");
  assert.equal(nonApi.kind, "fault");
  assert.match(nonApi.message, /didn't report a reason/);
});

test("only a genuine fault takes detector red and interrupts", () => {
  const alerting = API_ERROR_CODES.filter(
    (code) => queryErrorState(new ApiRequestError(code, "x", 500)).tone === "alert",
  );

  // Panel's "alert" tone is otherwise reserved for a run that failed its
  // contract (FailureCard). Spending it on every failure made a 404 and a
  // crashed backend look identical.
  for (const code of alerting) {
    const state = queryErrorState(new ApiRequestError(code, "x", 500));
    assert.equal(state.kind, "fault");
    assert.equal(state.role, "alert");
  }
  assert.ok(!alerting.includes("not_found"));
  assert.ok(!alerting.includes("unauthorized"));
  assert.ok(!alerting.includes("no_team"));
});

test("every contract code maps to a state, and only a retryable one retries", () => {
  const codes = [...API_ERROR_CODES, "network" as const, "unknown" as const];

  for (const code of codes) {
    const state = queryErrorState(new ApiRequestError(code, "Server sentence.", 500));
    assert.ok(state.message.length > 0, `${code} has no message`);
    // A student is never left with neither a button nor a link.
    assert.ok(state.retry || state.link !== null, `${code} is a dead end`);
    // Nothing that sends the student somewhere else also offers a retry;
    // the two would contradict each other.
    if (state.link && state.kind !== "missing") assert.equal(state.retry, false);
  }
});

test("every state a student reads follows the portal voice", () => {
  const codes = [...API_ERROR_CODES, "network" as const, "unknown" as const];
  const strings = [
    ...codes.flatMap((code) => {
      const state = queryErrorState(new ApiRequestError(code, "Server sentence.", 500));
      return [state.label ?? "", state.nextStep ?? "", state.link?.text ?? ""];
    }),
    // Only the strings this module authors. A server-authored message is the
    // route's to police, not this mapping's.
    queryErrorState(new ApiRequestError("network", "unused", 0)).message,
    queryErrorState(new ApiRequestError("not_found", "unused", 404)).message,
    queryErrorState(new ApiRequestError("unauthorized", "unused", 401)).message,
    queryErrorState(new ApiRequestError("no_team", "unused", 403)).message,
    queryErrorState(new ApiRequestError("no_cohort", "unused", 403)).message,
    queryErrorState(new ApiRequestError("forbidden", "unused", 403)).message,
    queryErrorState(new Error("x")).message,
  ];

  for (const value of strings) {
    assert.ok(!value.includes("—"), `em dash in: ${value}`);
    assert.ok(!value.includes("!"), `exclamation in: ${value}`);
    assert.ok(!/sorry|apolog|oops/i.test(value), `apology in: ${value}`);
  }
});

test("no two kinds put the same words on the screen", () => {
  // The grouping only pays for itself if a student can tell the groups apart.
  // Every code that lands on "fault" shares a label by design, and the sentence
  // that separates those is the server's, so the claim is about kinds: pick one
  // representative code per kind and compare everything the student actually
  // reads. Merging any two of these back together would show up here.
  const byKind = new Map<string, string>();
  const samples = [
    new ApiRequestError("network", "unused", 0),
    new ApiRequestError("not_found", "unused", 404),
    new ApiRequestError("unauthorized", "unused", 401),
    new ApiRequestError("no_team", "unused", 403),
    new ApiRequestError("provider_unconfigured", "The backend is unconfigured.", 500),
  ];

  for (const error of samples) {
    const state = queryErrorState(error);
    const read = [
      state.presentation,
      state.tone,
      state.label ?? "",
      state.message,
      state.nextStep ?? "",
      state.retry ? "retry" : "",
      state.link ? `${state.link.text} -> ${state.link.to}` : "",
    ].join(" | ");
    for (const [kind, other] of byKind) {
      assert.notEqual(read, other, `${state.kind} reads exactly like ${kind}`);
    }
    byKind.set(state.kind, read);
  }

  assert.equal(byKind.size, 5);
});

test("the three onboarding states each name their own missing step", () => {
  // no_cohort, no_team, and forbidden all map to "elsewhere", which is the one
  // place two states could collapse into the same screen without the kind
  // check above noticing.
  const states = ["no_cohort", "no_team", "forbidden"].map((code) =>
    queryErrorState(new ApiRequestError(code as "no_team", "unused", 403)),
  );

  assert.equal(new Set(states.map((s) => s.label)).size, 3);
  assert.equal(new Set(states.map((s) => s.message)).size, 3);
  assert.equal(new Set(states.map((s) => s.link?.to)).size, 3);
});

test("a label names the situation instead of repeating COULD NOT LOAD", () => {
  const labels = new Set(
    [
      new ApiRequestError("network", "x", 0),
      new ApiRequestError("unauthorized", "x", 401),
      new ApiRequestError("no_team", "x", 403),
      new ApiRequestError("provider_unconfigured", "x", 500),
    ].map((error) => queryErrorState(error).label),
  );

  assert.equal(labels.size, 4);
  assert.ok(!labels.has("COULD NOT LOAD"));
  for (const label of labels) assert.equal(label, label?.toUpperCase());
});
