import {
  BenchmarkSchema,
  SessionSchema,
  type Benchmark,
  type Session,
} from "@cogworks/contracts/schema";

/**
 * Deterministic session and track states for the public-entry tests.
 *
 * The four sessions cover where a visitor to `/` can actually stand: signed
 * out, signed in before the cohort, signed in before the team, and fully
 * onboarded. Each is parsed against the shipped SessionSchema at load, so a
 * contract change fails here instead of silently loosening an assertion.
 *
 * Every value is synthetic. The GitHub owner `cogworks-fixtures` does not
 * exist and no number, name, or version below describes a real deployment.
 */

const auth = {
  githubConfigured: true,
  devAuthEnabled: false,
  onboardingDevToolsEnabled: false,
  appSlug: "cogworks-fixtures",
  templateRepo: "cogworks-fixtures/capstone-template",
  executionProvider: "fixture",
} as const;

/** A signed-out visitor: `/session` answers with nulls plus the auth config
 *  (worker/routes/session.ts builds this via authToSession's null branch). */
export const SIGNED_OUT = SessionSchema.parse({
  user: null,
  cohort: null,
  team: null,
  auth,
});

/** A deployment where GitHub App OAuth was never finished. `/signin` shows a
 *  disabled GitHub button and the dev fold instead (SignInPage). */
export const SIGNED_OUT_GITHUB_UNCONFIGURED = SessionSchema.parse({
  ...SIGNED_OUT,
  auth: { ...auth, githubConfigured: false },
});

/** Signed in, no cohort yet: the next stage is /join (nextStagePath). */
export const PENDING_JOIN = SessionSchema.parse({
  user: {
    login: "entry-fixture-student",
    name: "Entry Fixture Student",
    avatarUrl: null,
    platformRole: "student",
    isOwner: false,
    isTa: false,
  },
  cohort: null,
  team: null,
  auth,
});

/** Signed in, cohort joined, no team yet: the next stage is /connect. */
export const PENDING_CONNECT = SessionSchema.parse({
  ...PENDING_JOIN,
  cohort: { slug: "entry-cohort", name: "Entry Fixture Cohort" },
});

/** Fully onboarded: cohort, team, and a connected repository. */
export const READY = SessionSchema.parse({
  user: PENDING_JOIN.user,
  cohort: PENDING_CONNECT.cohort,
  team: {
    id: "team_entry_fixture_1",
    name: "Entry Fixture Team",
    description: null,
    provenance: "live",
    repo: {
      owner: "cogworks-fixtures",
      name: "entry-fixture-capstone",
      fullName: "cogworks-fixtures/entry-fixture-capstone",
      url: "https://github.com/cogworks-fixtures/entry-fixture-capstone",
      defaultBranch: "main",
    },
  },
  auth,
});

/** One synthetic track in BenchmarkSchema's shape, for tests that need a
 *  selected benchmark beside a session (the entry's copy names the quota
 *  constants, not a track, so no test depends on these version strings). */
export const ENTRY_TRACK: Benchmark = BenchmarkSchema.parse({
  id: "vision-recognition",
  version: 1,
  contractVersion: "cogworks.submissions.v1",
  entryPointName: "vision-recognition",
  title: "Fixture track for entry tests",
  module: "vision",
  summary: "A synthetic benchmark that exists only so tests need no server.",
  active: true,
  pluginVersion: "0.0.0-entry-fixture",
  datasetVersion: "0.0.0-entry-fixture",
  scorerVersion: "0.0.0-entry-fixture",
  runtimeVersion: "0.0.0-entry-fixture",
});

export const ENTRY_STATES = {
  SIGNED_OUT,
  SIGNED_OUT_GITHUB_UNCONFIGURED,
  PENDING_JOIN,
  PENDING_CONNECT,
  READY,
} as const;
