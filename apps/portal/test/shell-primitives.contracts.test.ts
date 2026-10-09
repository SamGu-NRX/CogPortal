import assert from "node:assert/strict";
import { test } from "node:test";
import { SessionSchema, type Session } from "@cogworks/contracts/schema";
import {
  nextStagePath,
  staffGuardDecision,
  stageGuardDecision,
  type StageRequirement,
} from "../src/lib/stage-routing.ts";

/* Fixtures. Sessions are built through SessionSchema.parse so every valid
 * case is a session the real API client could produce. */

const authConfig = {
  githubConfigured: true,
  devAuthEnabled: false,
  onboardingDevToolsEnabled: false,
  appSlug: "cogworks-bwsi",
  templateRepo: "CogWorksBWSI/week2-vision-capstone",
  executionProvider: "fixture" as const,
};

const teamFixture = {
  id: "t1",
  name: "team one",
  description: null,
  repo: {
    owner: "CogWorksBWSI",
    name: "week2-vision-capstone",
    fullName: "CogWorksBWSI/week2-vision-capstone-team-one",
    url: "https://github.com/CogWorksBWSI/week2-vision-capstone-team-one",
    defaultBranch: "main",
  },
};

function user(overrides: Record<string, unknown> = {}) {
  return {
    login: "student-sam",
    name: "Sam",
    avatarUrl: null,
    platformRole: "student",
    isOwner: false,
    isTa: false,
    ...overrides,
  };
}

function session(overrides: Record<string, unknown> = {}): Session {
  return SessionSchema.parse({
    user: user(),
    cohort: { slug: "vision26", name: "Vision 2026" },
    team: teamFixture,
    auth: authConfig,
    ...overrides,
  });
}

/* nextStagePath: the onboarding ladder. */

test("nextStagePath sends a session with no user to sign-in", () => {
  assert.equal(nextStagePath(session({ user: null, cohort: null, team: null })), "/signin");
});

test("nextStagePath sends a user without a cohort to join", () => {
  assert.equal(nextStagePath(session({ cohort: null, team: null })), "/join");
});

test("nextStagePath sends a cohort without a team to connect", () => {
  assert.equal(nextStagePath(session({ team: null })), "/connect");
});

test("nextStagePath sends a full session to the dashboard", () => {
  assert.equal(nextStagePath(session()), "/dashboard");
});

test("nextStagePath ignores platform roles (documented behavior)", () => {
  const staff = session({ user: user({ platformRole: "staff", isTa: true }) });
  assert.equal(nextStagePath(session({ user: user({ platformRole: "staff" }), team: null })), "/connect");
  assert.equal(nextStagePath(session({ user: user({ isTa: true }), cohort: null, team: null })), "/join");
  assert.equal(nextStagePath(session({ user: user({ isOwner: true }), team: null })), "/connect");
  assert.equal(nextStagePath(staff), "/dashboard");
});

test("nextStagePath ignores fields it does not know", () => {
  const withExtra = { ...session(), futureField: "pending" };
  assert.equal(nextStagePath(withExtra), "/dashboard");
});

test("nextStagePath decides on presence, not content", () => {
  const sparse = session({
    user: user({ login: "", name: null, avatarUrl: null }),
    cohort: { slug: "", name: "" },
    team: { id: "", name: "", description: null, repo: null },
  });
  assert.equal(nextStagePath(sparse), "/dashboard");
});

test("nextStagePath rejects non-object sessions with a specific TypeError", () => {
  assert.throws(
    () => nextStagePath(null as unknown as Session),
    (error: unknown) =>
      error instanceof TypeError &&
      error.message ===
        "nextStagePath: expected a Session object from the session endpoint, received null",
  );
  assert.throws(
    () => nextStagePath(undefined as unknown as Session),
    (error: unknown) =>
      error instanceof TypeError &&
      error.message ===
        "nextStagePath: expected a Session object from the session endpoint, received undefined",
  );
  assert.throws(
    () => nextStagePath(42 as unknown as Session),
    (error: unknown) =>
      error instanceof TypeError &&
      error.message ===
        "nextStagePath: expected a Session object from the session endpoint, received number",
  );
  assert.throws(
    () => nextStagePath("student-sam" as unknown as Session),
    (error: unknown) =>
      error instanceof TypeError &&
      error.message ===
        "nextStagePath: expected a Session object from the session endpoint, received string",
  );
});

/* stageGuardDecision: the RequireStage route guard. */

test("stage guard renders the user stage for any signed-in session", () => {
  assert.deepEqual(
    stageGuardDecision("user", "/join", session({ cohort: null, team: null })),
    { action: "render" },
  );
});

test("stage guard redirects a signed-out visitor to sign-in", () => {
  assert.deepEqual(
    stageGuardDecision("team", "/dashboard", session({ user: null, cohort: null, team: null })),
    { action: "redirect", to: "/signin" },
  );
  assert.deepEqual(stageGuardDecision("user", "/dashboard", null), {
    action: "redirect",
    to: "/signin",
  });
  assert.deepEqual(stageGuardDecision("cohort", "/connect", undefined), {
    action: "redirect",
    to: "/signin",
  });
});

test("stage guard remembers the return target on a signed-out /connections visit", () => {
  assert.deepEqual(
    stageGuardDecision("user", "/connections", session({ user: null, cohort: null, team: null })),
    { action: "remember-and-redirect", to: "/signin", returnTo: "/connections" },
  );
  assert.deepEqual(
    stageGuardDecision(
      "cohort",
      "/connections?user_code=AB12CD",
      session({ user: null, cohort: null, team: null }),
    ),
    {
      action: "remember-and-redirect",
      to: "/signin",
      returnTo: "/connections?user_code=AB12CD",
    },
  );
  assert.deepEqual(
    stageGuardDecision(
      "team",
      "/connections#discord=neat-token",
      session({ user: null, cohort: null, team: null }),
    ),
    {
      action: "remember-and-redirect",
      to: "/signin",
      returnTo: "/connections#discord=neat-token",
    },
  );
  assert.deepEqual(
    stageGuardDecision(
      "user",
      "/connections?user_code=AB12CD#discord=neat-token",
      session({ user: null, cohort: null, team: null }),
    ),
    {
      action: "remember-and-redirect",
      to: "/signin",
      returnTo: "/connections?user_code=AB12CD#discord=neat-token",
    },
  );
});

test("stage guard only remembers the exact /connections route", () => {
  assert.deepEqual(
    stageGuardDecision("user", "/connections/other", session({ user: null, cohort: null, team: null })),
    { action: "redirect", to: "/signin" },
  );
  assert.deepEqual(
    stageGuardDecision("user", "//connections", session({ user: null, cohort: null, team: null })),
    { action: "redirect", to: "/signin" },
  );
});

test("stage guard sends a user without a cohort to join", () => {
  assert.deepEqual(
    stageGuardDecision("cohort", "/connect", session({ cohort: null, team: null })),
    { action: "redirect", to: "/join" },
  );
  assert.deepEqual(stageGuardDecision("team", "/dashboard", session({ cohort: null, team: null })), {
    action: "redirect",
    to: "/join",
  });
});

test("stage guard renders the cohort stage once a cohort exists", () => {
  assert.deepEqual(stageGuardDecision("cohort", "/connect", session({ team: null })), {
    action: "render",
  });
});

test("stage guard sends a cohort without a team to connect", () => {
  assert.deepEqual(stageGuardDecision("team", "/dashboard", session({ team: null })), {
    action: "redirect",
    to: "/connect",
  });
  assert.deepEqual(stageGuardDecision("team", "/dashboard", session()), { action: "render" });
});

test("stage guard ignores platform roles (documented behavior)", () => {
  assert.deepEqual(
    stageGuardDecision(
      "team",
      "/dashboard",
      session({ user: user({ platformRole: "staff" }), cohort: null, team: null }),
    ),
    { action: "redirect", to: "/join" },
  );
});

test("stage guard treats an out-of-contract stage as a cohort requirement", () => {
  const wizard = "wizard" as StageRequirement;
  assert.deepEqual(stageGuardDecision(wizard, "/dashboard", session()), { action: "render" });
  assert.deepEqual(
    stageGuardDecision(wizard, "/dashboard", session({ cohort: null, team: null })),
    { action: "redirect", to: "/join" },
  );
});

/* staffGuardDecision: the RequireStaff route guard. */

test("staff guard admits staff", () => {
  assert.deepEqual(
    staffGuardDecision(session({ user: user({ platformRole: "staff" }) })),
    { action: "render" },
  );
});

test("staff guard admits a TA whose platform role is student", () => {
  assert.deepEqual(staffGuardDecision(session({ user: user({ isTa: true }) })), {
    action: "render",
  });
  assert.deepEqual(
    staffGuardDecision(session({ user: user({ platformRole: "staff", isTa: true }) })),
    { action: "render" },
  );
});

test("staff guard sends students away from the admin console", () => {
  assert.deepEqual(staffGuardDecision(session()), { action: "redirect", to: "/" });
  assert.deepEqual(
    staffGuardDecision(session({ user: user({ isOwner: true }) })),
    { action: "redirect", to: "/" },
  );
});

test("staff guard sends a signed-out visitor to sign-in", () => {
  assert.deepEqual(staffGuardDecision(session({ user: null, cohort: null, team: null })), {
    action: "redirect",
    to: "/signin",
  });
  assert.deepEqual(staffGuardDecision(null), { action: "redirect", to: "/signin" });
  assert.deepEqual(staffGuardDecision(undefined), { action: "redirect", to: "/signin" });
});

test("staff guard fails closed on an unknown platform role", () => {
  const claimedOwner = {
    ...session(),
    user: { ...user(), platformRole: "owner" },
  } as unknown as Session;
  assert.deepEqual(staffGuardDecision(claimedOwner), { action: "redirect", to: "/" });
  const ownerTa = {
    ...session(),
    user: { ...user({ isTa: true }), platformRole: "owner" },
  } as unknown as Session;
  assert.deepEqual(staffGuardDecision(ownerTa), { action: "render" });
});
