import { ArrowRight01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useState } from "react";
import { Navigate, useNavigate, useSearchParams } from "react-router";
import { nextStagePath } from "@/App";
import { Button } from "@/components/Button";
import { LoadingMark, QueryError } from "@/components/Feedback";
import { GitHubIcon } from "@/components/GitHubIcon";
import { ApiRequestError } from "@/lib/api";
import { useDevLogin, useSession } from "@/lib/queries";
import { pendingConnectionReturn } from "@/lib/pending-return";

/**
 * What each `?error=` code from the GitHub callback means to the student.
 *
 * Better Auth redirects here with a machine code and nothing else
 * (`redirectOnError` in better-auth/dist/oauth2/errors.mjs); the Worker asks
 * it to by setting errorCallbackURL to /signin. Nothing else records a failed
 * callback, so a refusal this page does not name cannot be explained after the
 * fact, which is what happened to a sign-in on 2026-09-15.
 *
 * Only codes this deployment can reach are listed. Codes raised before the
 * OAuth state is parsed go to Better Auth's own /api/auth/error instead, and
 * the link-account codes need a linkSocialAccount flow the portal never uses.
 */
const SIGN_IN_ERRORS: Record<string, string> = {
  // A user row already holds this email and no github account row matches the
  // identity that just signed in. Enabling account linking would merge them,
  // which we deliberately don't do: githubLogin is the portal's identity, and
  // overrideUserInfoOnSignIn would rewrite it to the newer account.
  account_not_linked:
    "A Cog*Portal account already uses that email, and it isn't linked to this GitHub account. Sign in with the GitHub account you used before.",
  state_mismatch:
    "Your sign-in expired or began in another tab. Start again from this page.",
  invalid_code:
    "GitHub didn't accept the sign-in code. Start again from this page.",
  unable_to_get_user_info:
    "GitHub didn't answer when we asked who you are. Try again shortly.",
  email_not_found:
    "GitHub didn't send us an email address for that account, and we need one to make your Cog*Portal account. Ask course staff to take a look.",
  unable_to_create_user:
    "We couldn't create your Cog*Portal account. Ask course staff to take a look.",
  unable_to_create_session:
    "GitHub confirmed who you are, but we couldn't start your session. Try again shortly.",
};

export function signInErrorMessage(code: string): string {
  // GitHub and Better Auth both spell a cancellation with "denied"
  // (access_denied, oauth_denied), so it is matched rather than listed.
  if (code.includes("denied")) {
    return "GitHub sign-in was cancelled. Sign in again when you're ready.";
  }
  // hasOwn rather than a bare lookup: the code comes from the query string, so
  // ?error=__proto__ and ?error=constructor otherwise resolve to an inherited
  // Object member instead of undefined, and a `??` fallback never fires.
  if (Object.hasOwn(SIGN_IN_ERRORS, code)) return SIGN_IN_ERRORS[code];
  return "GitHub sign-in failed. Try again.";
}

export function SignInPage() {
  const sessionQuery = useSession();
  const { data: session } = sessionQuery;
  const navigate = useNavigate();
  const devLogin = useDevLogin();
  const [params] = useSearchParams();
  const [login, setLogin] = useState("");

  if (session?.user) {
    return <Navigate to={pendingConnectionReturn() ?? nextStagePath(session)} replace />;
  }

  // Without this branch an outage read as "sign-in isn't configured": no
  // session means no auth config, and the availability check below treats
  // absence as a disabled provider. A cached session still renders the form.
  if (sessionQuery.isError && !session) {
    return (
      <QueryError
        error={sessionQuery.error}
        retry={() => void sessionQuery.refetch()}
      />
    );
  }

  // The same mislabeling happens for the moment the first session read is in
  // flight: no data yet is not "provider disabled". Show the loading mark
  // until the answer exists.
  if (sessionQuery.isPending && !session) {
    return <LoadingMark />;
  }

  const auth = session?.auth;
  const oauthError = params.get("error");

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!login.trim() || devLogin.isPending) return;
    devLogin.mutate(
      { login: login.trim() },
      { onSuccess: (s) => navigate(pendingConnectionReturn() ?? nextStagePath(s), { replace: true }) },
    );
  };

  return (
    <div className="flex flex-1 items-center justify-center pt-10 pb-[calc(6rem+clamp(1rem,4dvh,2rem))]">
      <div className="anim-rise w-full max-w-sm">
        <h1 className="text-3xl">Sign in</h1>
        <p className="mt-2 text-[14px] text-ink-secondary">
          We use your GitHub account for sign-in, so you don't need a separate registration.
        </p>

        <div className="mt-8">
          {auth?.githubConfigured ? (
            <a
              href="/api/github/login"
              className="u-pressable flex h-12 w-full items-center justify-center gap-2.5 bg-ink text-[14px] font-medium tracking-wide text-paper-raised transition-colors duration-150 hover:bg-ink/90"
            >
              <GitHubIcon className="size-[18px]" />
              Continue with GitHub
            </a>
          ) : (
            <>
              <button
                disabled
                className="flex h-12 w-full cursor-not-allowed items-center justify-center gap-2.5 bg-ink/35 text-[14px] font-medium tracking-wide text-paper-raised"
              >
                <GitHubIcon className="size-[18px]" />
                Continue with GitHub
              </button>
              {/* Visible, not a hover title: keyboard and touch users have no
                  hover, and a disabled control takes no focus. */}
              <p className="mt-3 text-center text-[13px] text-ink-secondary">
                GitHub sign-in isn't configured. Ask course staff to enable it.
              </p>
            </>
          )}
          {oauthError && (
            <div role="alert" className="mt-3">
              {/* Left-aligned like the paragraph above the button: these
                  sentences run to three lines, and centering left a ragged
                  last line under a full-width control. */}
              <p className="text-[13px] text-detect-deep">{signInErrorMessage(oauthError)}</p>
              {/* The raw code stays on screen for every outcome, so a TA
                  reading over a student's shoulder has something to search.
                  Only something shaped like a Better Auth code, though: this
                  is a public route and the query string is whatever the link
                  said, so the page prints no other text as its own. */}
              {/^[a-z0-9_]{1,64}$/.test(oauthError) && (
                <p className="mt-1.5 font-mono text-[11px] tracking-[0.06em] text-ink-faint">
                  {oauthError}
                </p>
              )}
            </div>
          )}
        </div>

        {auth?.devAuthEnabled && (
          <form onSubmit={submit} className="mt-8 border-t border-rule-soft pt-6">
            <label htmlFor="dev-login" className="u-kicker block">
              Local sign-in
            </label>
            <div className="mt-2 flex gap-2">
              <input
                id="dev-login"
                value={login}
                onChange={(e) => setLogin(e.target.value)}
                autoComplete="username"
                spellCheck={false}
                className="h-11 min-w-0 flex-1 border border-rule bg-paper-sunken px-3 font-mono text-[14px] text-ink placeholder:text-ink-faint"
                placeholder="github username"
              />
              <Button
                type="submit"
                variant="ghost"
                busy={devLogin.isPending}
                disabled={!login.trim()}
              >
                Sign in
              </Button>
            </div>
            {devLogin.error && (
              <p role="alert" className="mt-2 text-[13px] text-detect-deep">
                {devLogin.error instanceof ApiRequestError
                  ? devLogin.error.message
                  : "Sign-in failed. Try again."}
              </p>
            )}
            <button
              type="button"
              disabled={devLogin.isPending}
              onClick={() =>
                devLogin.mutate(
                  { login: "demo", demo: true },
                  { onSuccess: () => navigate("/dashboard", { replace: true }) },
                )
              }
              className="u-pressable mt-4 inline-flex min-h-9 items-center gap-1.5 font-mono text-[11px] tracking-[0.09em] text-ink-secondary uppercase hover:text-ink disabled:opacity-50"
            >
              Enter demo mode
              <HugeiconsIcon icon={ArrowRight01Icon} size={13} strokeWidth={1.8} aria-hidden="true" />
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
