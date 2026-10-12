// Where each person lands on each SPA page: "<settled path> | <main heading>".
// Checked by s5-page-matrix.journey.mjs.

export const PAGE_IDENTITIES = [
  "signedOut",
  "revoked",
  "expired",
  "joiner",
  "outsider",
  "studentA",
  "studentB",
  "changedTeam",
  "taAssigned",
  "taUnassigned",
  "owner",
];


// SIGNED_OUT: no session, a revoked one, an expired one. STAFF: both TAs and
// the owner, none on a team. OTHER_TEAM: team B's member and team A's former
// member now on B; they get "no record" for A's run and console, the same
// answer as an address that never existed.
const SIGNED_OUT = ["signedOut", "revoked", "expired"];
const STAFF = ["taAssigned", "taUnassigned", "owner"];
const NOT_STAFF = ["joiner", "outsider", "studentA", "studentB", "changedTeam"];
const ON_A_TEAM = ["studentA", "studentB", "changedTeam"];
const OTHER_TEAM = ["studentB", "changedTeam"];
const EVERYONE = PAGE_IDENTITIES;

export const PAGE_POLICY = {
  "/": {
    "/ | See how your capstone holds up as the problem gets harder.": EVERYONE,
  },
  "/leaderboard": {
    "/leaderboard | Vision Overall": EVERYONE,
  },
  "/signin": {
    "/signin | Sign in": SIGNED_OUT,
    "/join | Join the cohort": ["joiner"],
    "/connect | Join or start your team": ["outsider"],
    "/dashboard | Semantic Image Search v1": ON_A_TEAM,
    "/admin | BWSI CogWorks 2026": STAFF,
  },
  "/join": {
    "/signin | Sign in": SIGNED_OUT,
    "/join | Join the cohort": ["joiner", "taAssigned", "taUnassigned", "owner"],
    "/connect | Join or start your team": ["outsider"],
    "/dashboard | Semantic Image Search v1": ON_A_TEAM,
  },
  "/connect": {
    "/signin | Sign in": SIGNED_OUT,
    "/join | Join the cohort": ["joiner", "taAssigned", "taUnassigned", "owner"],
    "/connect | Join or start your team": ["outsider"],
    "/dashboard | Semantic Image Search v1": ON_A_TEAM,
  },
  "/connections": {
    "/signin | Sign in": SIGNED_OUT,
    "/join | Join the cohort": ["joiner"],
    "/connect | Join or start your team": ["outsider"],
    "/connections | Connections": ON_A_TEAM,
    "/admin | BWSI CogWorks 2026": STAFF,
  },
  "/setup": {
    "/signin | Sign in": SIGNED_OUT,
    "/join | Join the cohort": ["joiner"],
    "/connect | Join or start your team": ["outsider"],
    "/setup | Set up your machine": ON_A_TEAM,
    "/admin | BWSI CogWorks 2026": STAFF,
  },
  "/dashboard": {
    "/signin | Sign in": SIGNED_OUT,
    "/join | Join the cohort": ["joiner"],
    "/connect | Join or start your team": ["outsider"],
    "/dashboard | Semantic Image Search v1": ON_A_TEAM,
    "/admin | BWSI CogWorks 2026": STAFF,
  },
  "/team": {
    "/signin | Sign in": SIGNED_OUT,
    "/join | Join the cohort": ["joiner"],
    "/connect | Join or start your team": ["outsider"],
    "/team | Demo Team": ["studentA"],
    "/team | Eigenfaces United": OTHER_TEAM,
    "/admin | BWSI CogWorks 2026": STAFF,
  },
  "/runs/:runId": {
    "/signin | Sign in": SIGNED_OUT,
    "/join | Join the cohort": ["joiner"],
    "/connect | Join or start your team": ["outsider"],
    "/runs/:runA | Practice run on main": ["studentA"],
    "/runs/:runA | main: The portal has no record at this address. Trying again will return the same answer. Back to your ru": OTHER_TEAM,
    "/admin | BWSI CogWorks 2026": STAFF,
  },
  "/run-surfaces/:surfaceId": {
    "/signin | Sign in": SIGNED_OUT,
    "/join | Join the cohort": ["joiner"],
    "/connect | Join or start your team": ["outsider"],
    "/run-surfaces/:surfaceA | Recognition": ["studentA"],
    "/run-surfaces/:surfaceA | main: The portal has no record at this address. Trying again will return the same answer. Back to your ru": OTHER_TEAM,
    "/admin | BWSI CogWorks 2026": STAFF,
  },
  "/admin": {
    "/signin | Sign in": SIGNED_OUT,
    "/ | See how your capstone holds up as the problem gets harder.": NOT_STAFF,
    "/admin | BWSI CogWorks 2026": STAFF,
  },
  "/desk": {
    "/signin | Sign in": SIGNED_OUT,
    "/ | See how your capstone holds up as the problem gets harder.": NOT_STAFF,
    "/desk | Where each team's work stands": STAFF,
  },
  "/desk/:teamId": {
    "/signin | Sign in": SIGNED_OUT,
    "/ | See how your capstone holds up as the problem gets harder.": NOT_STAFF,
    "/desk/:teamA | Demo Team": ["taAssigned", "owner"],
    "/desk/:teamA | main: All teams ACCESS REQUIRED Your account doesn't have access to this view. A TA can grant access if y": ["taUnassigned"],
  },
  "/__gallery": {
    "/__gallery | There's nothing at this address.": EVERYONE,
  },
  "/*": {
    "/rj-no-such-page | There's nothing at this address.": EVERYONE,
  },
};
