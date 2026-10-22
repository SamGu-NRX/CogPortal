import { Api } from "../lib/client.mts";
import { refused, SkipJourney, withStack, type Check, type Journey } from "../lib/framework.mts";

/**
 * Read the portal session cookie's Set-Cookie attributes and the auth
 * surface's cross-site mutation posture. Source contract (apps/portal/src/
 * lib/auth.ts and the Better Auth mount): the session cookie must be
 * HttpOnly, and its SameSite must be Lax or Strict — Better Auth's own CSRF
 * middleware refuses cross-site mutation attempts. The mutation arm's
 * verdict depends on that pairing: refusal is expected; a pass with
 * SameSite=None/No SameSite + no origin enforcement would be a FAIL, since
 * nothing would then stop a foreign site replaying the cookie.
 */
export const j8: Journey = {
  id: "j8-session-posture",
  title:
    "The portal session cookie is HttpOnly with a documented SameSite posture, the sign-out route actually revokes the session, and cross-site mutation is refused by origin enforcement or the cookie posture",
  fixedInput: "fresh stack; one student identity; observed Set-Cookie attributes",
  needsStack: true,
  async run(_stack, log) {
    return withStack("j8", log, async (stack) => {
      const checks: Check[] = [];
      // Bootstrap a live session WITHOUT the demo-team provisioning path:
      // demo:false skips connectTeam, which is broken at this head (its
      // post-onConflictDoNothing re-select returns null -> masked 500
      // provider_unconfigured) and is not needed for session-posture checks.
      const alice = new Api(stack.baseUrl);
      const login = await alice.req("POST", "/api/dev/login", {
        json: { login: "j8alice", demo: false, password: "cogportal-local-dev-password" },
      });
      if (login.status >= 400) {
        throw new SkipJourney(`student bootstrap unavailable: POST /api/dev/login (demo:false) -> HTTP ${login.status}: ${login.text.slice(0, 200)}`);
      }

      // --- login response set-cookies: capture raw attribute strings ---
      const cookies = login.headers.getSetCookie();
      const sessionCookie = cookies.find((c) => /session/i.test(c.split("=")[0]));
      checks.push(
        typeof sessionCookie === "string" && sessionCookie.includes("HttpOnly")
          ? { name: "POST /api/dev/login sets the portal session cookie with HttpOnly=true", ok: true, detail: sessionCookie.slice(0, 140) }
          : { name: "POST /api/dev/login sets the portal session cookie with HttpOnly=true", ok: false, detail: `set-cookies: ${cookies.join(" | ").slice(0, 200) || "none"}` },
      );
      if (!sessionCookie) return checks;
      const sameSiteMatch = /SameSite=(\w+)/i.exec(sessionCookie);
      const sameSite = sameSiteMatch?.[1]?.toLowerCase() ?? "none-declared";
      checks.push(
        sameSite === "lax" || sameSite === "strict"
          ? { name: "the portal session cookie is SameSite=Lax/Strict (browser-enforced CSRF defense)", ok: true, detail: `SameSite=${sameSite}` }
          : { name: "the portal session cookie is SameSite=Lax/Strict (browser-enforced CSRF defense)", ok: false, detail: `observed SameSite=${sameSite}; with no origin enforcement on mutation routes this is a finding` },
      );
      const sessionValue = sessionCookie.split("=")[1]?.split(";")[0] ?? "";
      checks.push(
        sessionValue.length > 64
          ? { name: "the portal session cookie carries a high-entropy token (signed session material, not a bare user id)", ok: true, detail: `value length ${sessionValue.length}` }
          : { name: "the portal session cookie carries a high-entropy token (signed session material, not a bare user id)", ok: false, detail: `value length ${sessionValue.length}` },
      );
      const activityCookie = cookies.find((c) => /activity/i.test(c.split("=")[0]));
      if (activityCookie && /SameSite=None/i.test(activityCookie) && !/Partitioned/i.test(activityCookie)) {
        checks.push({ name: "the Activity cookie keeps Partitioned=true when declared SameSite=None (CHIPS)", ok: false, detail: activityCookie.slice(0, 140) });
      }

      // --- cross-site mutation probe: Alice's cookies, foreign origin ---
      const invite = await alice.req("POST", "/api/team/members/invite", {
        json: { email: "attacker@evil.example", role: "member" },
        headers: { origin: "https://evil.example" },
      });
      log(`invite with evil origin -> ${invite.status}`);
      const inviteFetch = await alice.req("POST", "/api/team/members/invite", {
        json: { email: "attacker2@evil.example", role: "member" },
        headers: { "sec-fetch-site": "cross-site" },
      });
      log(`invite with sec-fetch-site=cross-site -> ${inviteFetch.status}`);
      const inviteBenign = await alice.req("POST", "/api/team/members/invite", {
        json: { email: "benign-colleague@example.com", role: "member" },
      });
      log(`same-origin invite baseline -> ${inviteBenign.status}`);
      const originEnforced = invite.status >= 400 && inviteFetch.status >= 400 && inviteBenign.status < 400;
      checks.push(
        originEnforced || sameSite === "lax" || sameSite === "strict"
          ? { name: "POST /api/team/members/invite with a foreign origin is refused by origin enforcement or the SameSite cookie posture", ok: true, detail: `origin-probe HTTP ${invite.status}, fetch-site-probe HTTP ${inviteFetch.status}; cookie SameSite=${sameSite}` }
          : { name: "POST /api/team/members/invite with a foreign origin is refused by origin enforcement or the SameSite cookie posture", ok: false, detail: `origin-probe HTTP ${invite.status}, fetch-site-probe HTTP ${inviteFetch.status}; cookie SameSite=${sameSite} with no Partitioned flag — cross-site replay is browser-permitted and the app does not refuse it` },
      );

      // --- sign-out then reuse: the old session must actually revoke ---
      // Snapshot the LIVE session cookie first: sign-out rewrites the jar
      // (the deletion Set-Cookie empties it), so a post-sign-out replay from
      // the jar would prove nothing about server-side revocation.
      const preLogoutCookie = alice.cookieHeader();
      const signedOut = await alice.req("POST", "/api/auth/sign-out");
      checks.push(
        signedOut.status >= 200 && signedOut.status < 300
          ? { name: "POST /api/auth/sign-out succeeds for the live session", ok: true, detail: `HTTP ${signedOut.status}` }
          : { name: "POST /api/auth/sign-out succeeds for the live session", ok: false, detail: `HTTP ${signedOut.status}: ${signedOut.text.slice(0, 160)}` },
      );
      const after = await alice.req("GET", "/api/team", { headers: { cookie: preLogoutCookie } });
      checks.push(refused("GET /api/team with the replayed pre-logout session cookie refuses — sign-out revoked it server-side", after.status, after.text));
      const authState = await alice.req("GET", "/api/auth/get-session", { headers: { cookie: preLogoutCookie } });
      checks.push(
        authState.status >= 400 || authState.text.trim() === "null" || authState.text.trim() === ""
          ? { name: "GET /api/auth/get-session with the replayed pre-logout cookie reports no authenticated user", ok: true, detail: `HTTP ${authState.status}, body ${authState.text.slice(0, 60)}` }
          : { name: "GET /api/auth/get-session with the replayed pre-logout cookie reports no authenticated user", ok: false, detail: `HTTP ${authState.status}, body ${authState.text.slice(0, 120)}` },
      );
      // The refusal above must be the revocation, not a transient backend
      // error: a fresh sign-in on the same stack still authenticates.
      const bob = new Api(stack.baseUrl);
      const bobLogin = await bob.req("POST", "/api/dev/login", {
        json: { login: "j8bob2", demo: false, password: "cogportal-local-dev-password" },
      });
      const bobProbe = await bob.req("GET", "/api/session");
      const bobBody = bobProbe.json() as { user?: unknown } | null;
      checks.push(
        bobLogin.status < 400 && bobProbe.status === 200 && bobBody?.user != null
          ? { name: "a fresh session still authenticates on the same stack (the refusal is the revocation, not a transient failure)", ok: true, detail: "fresh demo:false session GET /api/session HTTP 200 with a non-null user" }
          : { name: "a fresh session still authenticates on the same stack (the refusal is the revocation, not a transient failure)", ok: false, detail: `login HTTP ${bobLogin.status}, GET /api/session HTTP ${bobProbe.status}: ${bobProbe.text.slice(0, 120)}` },
      );
      // Double sign-out: Better Auth's sign-out on a dead session is a
      // documented idempotent success (no leak of session existence).
      const secondSignOut = await alice.req("POST", "/api/auth/sign-out");
      checks.push(
        secondSignOut.status >= 200 && secondSignOut.status < 300
          ? { name: "POST /api/auth/sign-out again is the documented idempotent success (does not leak session existence)", ok: true, detail: `HTTP ${secondSignOut.status}` }
          : { name: "POST /api/auth/sign-out again is the documented idempotent success (does not leak session existence)", ok: false, detail: `HTTP ${secondSignOut.status}` },
      );

      return checks;
    });
  },
}
