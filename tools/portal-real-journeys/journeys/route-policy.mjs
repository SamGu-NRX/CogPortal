// Who may call what, as exact answers. Written from the guards in
// apps/portal/worker (requireUser, requireTeam, requireShownTeam,
// requireAdminOfShownTeam, requireStaff/requireOwner/requireTeamScope,
// requireDevice, requireActivityTeam, verifyRunnerSignature) and checked
// against the Worker by s5-route-matrix.journey.mjs.

/** Every identity the matrix sends each request as (journeys/world.mjs). */
export const IDENTITIES = [
  "signedOut",
  "revoked",
  "expired",
  "joiner",
  "outsider",
  "studentA",
  "teammateA",
  "studentB",
  "changedTeam",
  "taAssigned",
  "taUnassigned",
  "owner",
  "deviceA",
  "deviceRevoked",
  "deviceExpired",
  "deviceB",
  "activityA",
  "activityNoTeam",
  "activityUnlinked",
];

/**
 * Routes with no positive control here, and why. Each is a named gate in
 * docs/plan/real-user-readiness.md ("What Sam must provide").
 */
export const NO_POSITIVE = {
  "GET /api/github/login": "starts GitHub OAuth, which a development Worker doesn't configure; needs a test GitHub OAuth app",
  "GET /api/github/installations": "reads the caller's GitHub token; dev accounts have none; needs a test GitHub account",
  "GET /api/v1/runs/:id/weights/*": "serves weights recorded on a Modal dispatch; the fixture provider dispatches nothing; needs Modal",
};

// Identity groups the table below names. Each is exactly these identities.
// No portal session: signed out, a session revoked on the server or past its
// expiry, CLI device tokens, Activity sessions (a bearer token or an Activity
// cookie is not a portal session).
const NO_SESSION = ["signedOut", "revoked", "expired", "deviceA", "deviceRevoked", "deviceExpired", "deviceB", "activityA", "activityNoTeam", "activityUnlinked"];
// Everything but a CLI device token.
const NO_DEVICE = ["signedOut", "revoked", "expired", "joiner", "outsider", "studentA", "teammateA", "studentB", "changedTeam", "taAssigned", "taUnassigned", "owner", "activityA", "activityNoTeam", "activityUnlinked"];
// Everything but an Activity session.
const NO_ACTIVITY = ["signedOut", "revoked", "expired", "joiner", "outsider", "studentA", "teammateA", "studentB", "changedTeam", "taAssigned", "taUnassigned", "owner", "deviceA", "deviceRevoked", "deviceExpired", "deviceB"];
// Any live portal session.
const SESSION = ["joiner", "outsider", "studentA", "teammateA", "studentB", "changedTeam", "taAssigned", "taUnassigned", "owner"];
// Live sessions on no team: signed in only, in the cohort only, both TAs, the owner.
const TEAMLESS = ["joiner", "outsider", "taAssigned", "taUnassigned", "owner"];
// Live sessions on a team: A's admin and member, B's member, and A's former member now on B.
const ON_A_TEAM = ["studentA", "teammateA", "studentB", "changedTeam"];
// Live sessions that aren't staff.
const STUDENTS = ["joiner", "outsider", "studentA", "teammateA", "studentB", "changedTeam"];
const EVERYONE = IDENTITIES;

/**
 * Route -> exact answer -> who gets it. An answer is the status, then for an
 * error the code and message exactly as the Worker writes them ("text:" for
 * the one route that answers in plain text). Things worth knowing when
 * reading it:
 * - Team A's run, console and desk refuse team B's member and A's former
 *   member with 404 (not 403), so a team can't learn what another has.
 * - A request that names a team ("shown team") gets 409 from anyone whose
 *   session is on a different team, with the team they're on now.
 * - TAs are staff only for their assigned team: the unassigned TA reads the
 *   overview and desk list (scoped to their own teams) and is refused team A.
 * - Owner-only routes refuse both TAs; staff routes refuse every student.
 */
export const POLICY = {
  "ALL /api/auth/*": {
    "200": EVERYONE,
  },
  "GET /api/session": {
    "200": EVERYONE,
  },
  "POST /api/dev/login": {
    "400 invalid_request: The request body is invalid.": EVERYONE,
  },
  "POST /api/cohorts/join": {
    "401 unauthorized: Sign in to continue.": NO_SESSION,
    "403 cohort_code_invalid: The cohort join code is invalid.": SESSION,
  },
  "GET /api/github/login": {
    "404 not_found: GitHub sign-in is not configured.": EVERYONE,
  },
  "GET /api/github/repositories": {
    "200": SESSION,
    "401 unauthorized: Sign in to continue.": NO_SESSION,
  },
  "POST /api/github/connect": {
    "401 unauthorized: Sign in to continue.": NO_SESSION,
    "403 no_cohort: Join a cohort first.": ["joiner", "taAssigned", "taUnassigned", "owner"],
    "403 forbidden: Sign in with GitHub to connect a repository.": ["outsider"],
    "409 already_on_team: You are already on a team.": ON_A_TEAM,
  },
  "GET /api/github/installations": {
    "401 unauthorized: Sign in to continue.": NO_SESSION,
    "403 forbidden: Sign in with GitHub to view installations.": SESSION,
  },
  "POST /api/github/webhook": {
    "401 unauthorized: Invalid webhook signature.": EVERYONE,
  },
  "POST /api/runs/practice": {
    "401 unauthorized: Sign in to continue.": NO_SESSION,
    "403 no_team: Connect a repository to continue.": TEAMLESS,
    "409 already_on_team: You're on Demo Team now, not the team this page showed. Reload to see it.": ["studentA", "teammateA"],
    "409 already_on_team: You're on Eigenfaces United now, not the team this page showed. Reload to see it.": ["studentB", "changedTeam"],
  },
  "POST /api/runs/:id/promote": {
    "401 unauthorized: Sign in to continue.": NO_SESSION,
    "403 no_team: Connect a repository to continue.": TEAMLESS,
    "404 not_found: Run not found.": ["studentA", "teammateA"],
    "403 forbidden: Sign in to GitHub on Cog*Portal before changing a run.": ["studentB", "changedTeam"],
  },
  "GET /api/runs": {
    "200": ON_A_TEAM,
    "401 unauthorized: Sign in to continue.": NO_SESSION,
    "403 no_team: Connect a repository to continue.": TEAMLESS,
  },
  "GET /api/v1/runs/:id/weights/*": {
    "401 unauthorized: Unknown runner signing key.": EVERYONE,
  },
  "GET /api/runs/:id": {
    "200": ["studentA", "teammateA"],
    "401 unauthorized: Sign in to continue.": NO_SESSION,
    "403 no_team: Connect a repository to continue.": TEAMLESS,
    "404 not_found: Run not found.": ["studentB", "changedTeam"],
  },
  "GET /api/dashboard": {
    "200": ON_A_TEAM,
    "401 unauthorized: Sign in to continue.": NO_SESSION,
    "403 no_team: Connect a repository to continue.": TEAMLESS,
  },
  "PUT /api/leaderboard-selection": {
    "401 unauthorized: Sign in to continue.": NO_SESSION,
    "403 no_team: Connect a repository to continue.": TEAMLESS,
    "404 not_found: Run not found.": ["studentA", "teammateA"],
    "403 forbidden: Sign in to GitHub on Cog*Portal before changing a run.": ["studentB", "changedTeam"],
  },
  "GET /api/leaderboard": {
    "200": EVERYONE,
  },
  "GET /api/v1/leaderboard": {
    "200": EVERYONE,
  },
  "GET /api/leaderboard-family": {
    "200": EVERYONE,
  },
  "GET /api/benchmarks": {
    "200": EVERYONE,
  },
  "GET /api/v1/benchmarks": {
    "200": EVERYONE,
  },
  "GET /api/team": {
    "200": ON_A_TEAM,
    "401 unauthorized: Sign in to continue.": NO_SESSION,
    "403 no_team: Connect a repository to continue.": TEAMLESS,
  },
  "GET /api/v1/team/process": {
    "200": ON_A_TEAM,
    "401 unauthorized: Sign in to continue.": NO_SESSION,
    "403 no_team: Connect a repository to continue.": TEAMLESS,
  },
  "PATCH /api/team": {
    "200": ["studentA"],
    "401 unauthorized: Sign in to continue.": NO_SESSION,
    "403 no_team: Connect a repository to continue.": TEAMLESS,
    "403 forbidden: Only a team admin can change team settings.": ["teammateA"],
    "409 already_on_team: You're on Eigenfaces United now, not the team this page showed. Reload to see it.": ["studentB", "changedTeam"],
  },
  "POST /api/team/repository": {
    "200": ["studentA"],
    "401 unauthorized: Sign in to continue.": NO_SESSION,
    "403 no_team: Connect a repository to continue.": TEAMLESS,
    "403 forbidden: Only a team admin can change team settings.": ["teammateA"],
    "409 already_on_team: You're on Eigenfaces United now, not the team this page showed. Reload to see it.": ["studentB", "changedTeam"],
  },
  "GET /api/cohorts/teams": {
    "200": ["outsider", "studentA", "teammateA", "studentB", "changedTeam"],
    "401 unauthorized: Sign in to continue.": NO_SESSION,
    "403 no_cohort: Join a cohort first.": ["joiner", "taAssigned", "taUnassigned", "owner"],
  },
  "POST /api/team/join": {
    "401 unauthorized: Sign in to continue.": NO_SESSION,
    "403 no_cohort: Join a cohort first.": ["joiner", "taAssigned", "taUnassigned", "owner"],
    "404 not_found: Team not found.": ["outsider"],
    "409 already_on_team: You are already on a team.": ON_A_TEAM,
  },
  "POST /api/team/leave": {
    "200": TEAMLESS,
    "401 unauthorized: Sign in to continue.": NO_SESSION,
    "409 already_on_team: You're on Demo Team now, not the team this page showed. Reload to see it.": ["studentA", "teammateA"],
    "409 already_on_team: You're on Eigenfaces United now, not the team this page showed. Reload to see it.": ["studentB", "changedTeam"],
  },
  "GET /api/team/invitable": {
    "200": ["studentA"],
    "401 unauthorized: Sign in to continue.": NO_SESSION,
    "403 no_team: Connect a repository to continue.": TEAMLESS,
    "403 forbidden: Only a team admin can change team settings.": ["teammateA", "studentB", "changedTeam"],
  },
  "POST /api/team/members": {
    "401 unauthorized: Sign in to continue.": NO_SESSION,
    "403 no_team: Connect a repository to continue.": TEAMLESS,
    "404 user_not_found: No CogPortal account with that GitHub login yet. They need to sign in once first.": ["studentA"],
    "403 forbidden: Only a team admin can change team settings.": ["teammateA"],
    "409 already_on_team: You're on Eigenfaces United now, not the team this page showed. Reload to see it.": ["studentB", "changedTeam"],
  },
  "DELETE /api/team/members/:login": {
    "401 unauthorized: Sign in to continue.": NO_SESSION,
    "403 no_team: Connect a repository to continue.": TEAMLESS,
    "404 not_found: Team member not found.": ["studentA"],
    "403 forbidden: Only a team admin can change team settings.": ["teammateA"],
    "409 already_on_team: You're on Eigenfaces United now, not the team this page showed. Reload to see it.": ["studentB", "changedTeam"],
  },
  "GET /api/v1/connections": {
    "200": SESSION,
    "401 unauthorized: Sign in to continue.": NO_SESSION,
  },
  "POST /api/v1/connections/discord/preview": {
    "401 unauthorized: Sign in to continue.": NO_SESSION,
    "403 no_team: Connect a repository to continue.": TEAMLESS,
    "410 link_expired: This Discord link has expired. Open /cog in the course server to get a new one.": ON_A_TEAM,
  },
  "POST /api/v1/connections/discord/confirm": {
    "401 unauthorized: Sign in to continue.": NO_SESSION,
    "403 no_team: Connect a repository to continue.": TEAMLESS,
    "410 link_expired: This Discord link has expired. Open /cog in the course server to get a new one.": ON_A_TEAM,
  },
  "POST /api/v1/cli/device/start": {
    "200": EVERYONE,
  },
  "POST /api/v1/cli/device/approve": {
    "401 unauthorized: Sign in to continue.": NO_SESSION,
    "403 no_team: Connect a repository to continue.": TEAMLESS,
    "410 link_expired: The device code is invalid, expired, or already used.": ON_A_TEAM,
  },
  "POST /api/v1/cli/device/token": {
    "410 link_expired: The device authorization expired. Start again.": EVERYONE,
  },
  "DELETE /api/v1/cli/devices": {
    "200": SESSION,
    "401 unauthorized: Sign in to continue.": NO_SESSION,
  },
  "GET /api/v1/cli/device/status": {
    "200": ["deviceA", "deviceB"],
    "401 unauthorized: Sign in to continue.": ["signedOut", "revoked", "expired", "activityA", "activityNoTeam", "activityUnlinked"],
    "400 invalid_request: A device code is required.": SESSION,
    "401 invalid_token: This CogWorks connection expired or was revoked. Run `cogworks link` to connect this machine again.": ["deviceRevoked", "deviceExpired"],
  },
  "POST /api/v1/local-reports": {
    "201": ["deviceA"],
    "401 invalid_token: A linked CogBench device token is required.": NO_DEVICE,
    "401 invalid_token: This CogWorks connection expired or was revoked. Run `cogworks link` to connect this machine again.": ["deviceRevoked", "deviceExpired"],
    "409 forbidden: That report ID belongs to another account.": ["deviceB"],
  },
  "PUT /api/v1/local-reports/:reportId/weights/*": {
    "401 invalid_token: A linked CogBench device token is required.": NO_DEVICE,
    "404 not_found: Local report not found.": ["deviceA", "deviceB"],
    "401 invalid_token: This CogWorks connection expired or was revoked. Run `cogworks link` to connect this machine again.": ["deviceRevoked", "deviceExpired"],
  },
  "GET /api/v1/local-reports": {
    "200": ON_A_TEAM,
    "401 unauthorized: Sign in to continue.": NO_SESSION,
    "403 no_team: Connect a repository to continue.": TEAMLESS,
  },
  "POST /api/v1/local-runs": {
    "201": ["deviceA"],
    "401 invalid_token: A linked CogBench device token is required.": NO_DEVICE,
    "401 invalid_token: This CogWorks connection expired or was revoked. Run `cogworks link` to connect this machine again.": ["deviceRevoked", "deviceExpired"],
    "409 forbidden: This device is running cogworks-demo/face-finder, but your team is connected to cogworks-demo/eigenfaces-united.": ["deviceB"],
  },
  "POST /api/v1/local-runs/:id/events": {
    "200": ["deviceA"],
    "401 invalid_token: A linked CogBench device token is required.": NO_DEVICE,
    "401 invalid_token: This CogWorks connection expired or was revoked. Run `cogworks link` to connect this machine again.": ["deviceRevoked", "deviceExpired"],
    "404 not_found: Local run session not found.": ["deviceB"],
  },
  "POST /api/v1/local-runs/:id/events/batch": {
    "200": ["deviceA"],
    "401 invalid_token: A linked CogBench device token is required.": NO_DEVICE,
    "401 invalid_token: This CogWorks connection expired or was revoked. Run `cogworks link` to connect this machine again.": ["deviceRevoked", "deviceExpired"],
    "404 not_found: Local run session not found.": ["deviceB"],
  },
  "POST /api/internal/v1/runner/events": {
    "401 unauthorized: Unknown runner signing key.": EVERYONE,
  },
  "GET /api/run-surfaces": {
    "200": ON_A_TEAM,
    "401 unauthorized: Sign in to continue.": NO_SESSION,
    "403 no_team: Connect a repository to continue.": TEAMLESS,
  },
  "GET /api/run-surfaces/:id": {
    "200": ["studentA", "teammateA"],
    "401 unauthorized: Sign in to continue.": NO_SESSION,
    "403 no_team: Connect a repository to continue.": TEAMLESS,
    "404 not_found: Run surface not found.": ["studentB", "changedTeam"],
  },
  "POST /api/run-surfaces/:id/actions/:action": {
    "401 unauthorized: Sign in to continue.": NO_SESSION,
    "403 no_team: Connect a repository to continue.": TEAMLESS,
    "404 not_found: API route not found.": ["studentA", "teammateA"],
    "404 not_found: Run surface not found.": ["studentB", "changedTeam"],
  },
  "GET /api/run-surfaces/:id/stream": {
    "401 unauthorized: Sign in to continue.": NO_SESSION,
    "403 no_team: Connect a repository to continue.": TEAMLESS,
    "426 invalid_request: Expected a WebSocket upgrade.": ["studentA", "teammateA"],
    "404 not_found: Run surface not found.": ["studentB", "changedTeam"],
  },
  "GET /api/admin/overview": {
    "200": ["taAssigned", "taUnassigned", "owner"],
    "401 unauthorized: Sign in to continue.": NO_SESSION,
    "403 forbidden: Staff access required.": STUDENTS,
  },
  "PATCH /api/admin/cohort": {
    "200": ["owner"],
    "401 unauthorized: Sign in to continue.": NO_SESSION,
    "403 forbidden: Staff access required.": STUDENTS,
    "403 forbidden: Owner access required.": ["taAssigned", "taUnassigned"],
  },
  "PATCH /api/admin/teams/:teamId": {
    "200": ["taAssigned", "owner"],
    "401 unauthorized: Sign in to continue.": NO_SESSION,
    "403 forbidden: Staff access required.": STUDENTS,
    "403 forbidden: This team is not assigned to you.": ["taUnassigned"],
  },
  "POST /api/admin/teams/:teamId/members": {
    "401 unauthorized: Sign in to continue.": NO_SESSION,
    "403 forbidden: Staff access required.": STUDENTS,
    "404 not_found: User not found.": ["taAssigned", "owner"],
    "403 forbidden: This team is not assigned to you.": ["taUnassigned"],
  },
  "DELETE /api/admin/teams/:teamId/members/:login": {
    "200": ["taAssigned", "owner"],
    "401 unauthorized: Sign in to continue.": NO_SESSION,
    "403 forbidden: Staff access required.": STUDENTS,
    "403 forbidden: This team is not assigned to you.": ["taUnassigned"],
  },
  "POST /api/admin/teams/:teamId/tas": {
    "401 unauthorized: Sign in to continue.": NO_SESSION,
    "403 forbidden: Staff access required.": STUDENTS,
    "403 forbidden: Owner access required.": ["taAssigned", "taUnassigned"],
    "404 not_found: User must sign in before being assigned as a TA.": ["owner"],
  },
  "DELETE /api/admin/teams/:teamId/tas/:login": {
    "200": ["owner"],
    "401 unauthorized: Sign in to continue.": NO_SESSION,
    "403 forbidden: Staff access required.": STUDENTS,
    "403 forbidden: Owner access required.": ["taAssigned", "taUnassigned"],
  },
  "GET /api/admin/staff": {
    "200": ["owner"],
    "401 unauthorized: Sign in to continue.": NO_SESSION,
    "403 forbidden: Staff access required.": STUDENTS,
    "403 forbidden: Owner access required.": ["taAssigned", "taUnassigned"],
  },
  "POST /api/admin/staff": {
    "200": ["owner"],
    "401 unauthorized: Sign in to continue.": NO_SESSION,
    "403 forbidden: Staff access required.": STUDENTS,
    "403 forbidden: Owner access required.": ["taAssigned", "taUnassigned"],
  },
  "DELETE /api/admin/staff/:login": {
    "200": ["owner"],
    "401 unauthorized: Sign in to continue.": NO_SESSION,
    "403 forbidden: Staff access required.": STUDENTS,
    "403 forbidden: Owner access required.": ["taAssigned", "taUnassigned"],
  },
  "GET /api/admin/desk/teams": {
    "200": ["taAssigned", "taUnassigned", "owner"],
    "401 unauthorized: Sign in to continue.": NO_SESSION,
    "403 forbidden: Staff access required.": STUDENTS,
  },
  "GET /api/admin/desk/teams/:teamId": {
    "200": ["taAssigned", "owner"],
    "401 unauthorized: Sign in to continue.": NO_SESSION,
    "403 forbidden: Staff access required.": STUDENTS,
    "403 forbidden: This team is not assigned to you.": ["taUnassigned"],
  },
  "GET /api/admin/desk/teams/:teamId/runs": {
    "200": ["taAssigned", "owner"],
    "401 unauthorized: Sign in to continue.": NO_SESSION,
    "403 forbidden: Staff access required.": STUDENTS,
    "403 forbidden: This team is not assigned to you.": ["taUnassigned"],
  },
  "GET /api/activity/oauth/state": {
    "200": EVERYONE,
  },
  "POST /api/activity/oauth/token": {
    "400 invalid_request: The Discord Activity authorization state expired.": EVERYONE,
  },
  "GET /api/activity/session": {
    "200": ["activityA", "activityNoTeam", "activityUnlinked"],
    "401 unauthorized: Open the Cog Activity again.": NO_ACTIVITY,
  },
  "GET /api/activity/run-surfaces": {
    "200": ["activityA"],
    "401 unauthorized: Open the Cog Activity again.": NO_ACTIVITY,
    "403 no_team: Link Discord and finish joining a Cog*Portal team first.": ["activityNoTeam", "activityUnlinked"],
  },
  "POST /api/activity/run-surfaces/:id/actions/:action": {
    "401 unauthorized: Open the Cog Activity again.": NO_ACTIVITY,
    "404 not_found: API route not found.": ["activityA"],
    "403 no_team: Link Discord and finish joining a Cog*Portal team first.": ["activityNoTeam", "activityUnlinked"],
  },
  "GET /api/activity/run-surfaces/:id/stream": {
    "401 unauthorized: Open the Cog Activity again.": NO_ACTIVITY,
    "426 invalid_request: Expected a WebSocket upgrade.": ["activityA"],
    "403 no_team: Link Discord and finish joining a Cog*Portal team first.": ["activityNoTeam", "activityUnlinked"],
  },
  "GET /api/v1/setup/state": {
    "200": ON_A_TEAM,
    "401 unauthorized: Sign in to continue.": NO_SESSION,
    "403 no_team: Connect a repository to continue.": TEAMLESS,
  },
  "POST /api/v1/setup/check-off": {
    "400 text: CogPortal: this check-off command is stale. Copy a fresh one from the setup page.": EVERYONE,
  },
  "POST /api/v1/cli/setup/checks": {
    "200": ["deviceA"],
    "401 invalid_token: A linked CogBench device token is required.": NO_DEVICE,
    "401 invalid_token: This CogWorks connection expired or was revoked. Run `cogworks link` to connect this machine again.": ["deviceRevoked", "deviceExpired"],
    "409 invalid_request: This directory is cogworks-demo/face-finder, but CogPortal expects cogworks-demo/eigenfaces-united.": ["deviceB"],
  },
  "DELETE /api/v1/setup/state": {
    "401 unauthorized: Sign in to continue.": NO_SESSION,
    "403 no_team: Connect a repository to continue.": TEAMLESS,
    "404 not_found: API route not found.": ON_A_TEAM,
  },
  "DELETE /api/v1/connections/discord": {
    "200": SESSION,
    "401 unauthorized: Sign in to continue.": NO_SESSION,
  },
  "POST /api/session/logout": {
    "200": EVERYONE,
  },
};
