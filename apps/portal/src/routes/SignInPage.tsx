import { ArrowDown01Icon, ArrowRight01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useState } from "react";
import { Navigate, useNavigate, useSearchParams } from "react-router";
import { nextStagePath } from "@/App";
import type { Session } from "@cogworks/contracts/schema";
import { Button, buttonClass } from "@/components/Button";
import { LoadingMark, QueryError } from "@/components/Feedback";
import { GitHubIcon } from "@/components/GitHubIcon";
import { Annotated } from "@/components/Note";
import { OnboardingPath } from "@/components/OnboardingPath";
import { ApiRequestError } from "@/lib/api";
import { useDevLogin, useSession } from "@/lib/queries";
import { pendingReturn } from "@/lib/pending-return";

/**
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

function signInErrorMessage(code: string): string {
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

/** The dev-login request schema (packages/contracts, DevLoginRequestSchema):
 *  a GitHub-shaped name. Checked here so a typo gets a sentence about the
 *  name instead of the server's "The request body is invalid." */
const DEV_LOGIN = /^[a-zA-Z0-9-]{1,39}$/;

export function SignInPage() {
  const sessionQuery = useSession();
  const { data: session } = sessionQuery;
  const navigate = useNavigate();
  const devLogin = useDevLogin();
  const [params] = useSearchParams();
  const [login, setLogin] = useState("");
  const [loginShapeError, setLoginShapeError] = useState(false);
  // Null until the student touches it, so the default can follow the
  // deployment (see `devOpen` below) without a sync effect.
  const [devToggled, setDevToggled] = useState<boolean | null>(null);

  if (session?.user) {
    return <Navigate to={pendingReturn() ?? nextStagePath(session)} replace />;
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
  // The fold is for people working on the portal. When GitHub isn't
  // configured it holds the only sign-in that works, so it starts open
  // rather than leaving a disabled button as the whole page.
  const devOpen = devToggled ?? !auth?.githubConfigured;
  const afterSignIn = (s: Session) =>
    navigate(pendingReturn() ?? nextStagePath(s), { replace: true });

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const name = login.trim();
    if (!name || devLogin.isPending) return;
    if (!DEV_LOGIN.test(name)) {
      setLoginShapeError(true);
      return;
    }
    devLogin.mutate({ login: name }, { onSuccess: afterSignIn });
  };

  const devError = loginShapeError
    ? "A GitHub username is letters, numbers, and hyphens, up to 39 characters."
    : devLogin.error instanceof ApiRequestError
      ? devLogin.error.message
      : devLogin.error
        ? "Sign-in failed. Try again."
        : null;

  return (
    <div className="page anim-rise [--measure:27rem]">
      <OnboardingPath current="signin" className="max-w-[27rem]" />

      <header className="mt-10 max-w-[27rem]">
        <h1 className="text-[clamp(2rem,1.5rem+2vw,2.5rem)] text-ink">Sign in</h1>
        <p className="mt-3 text-[16px] leading-[1.6] text-ink-secondary">
          We use your GitHub account, so there's no new password to keep track of.
        </p>
      </header>

      {/* The note sits beside the action it explains, not the title: on a
          phone it then reads between the lede and the button. */}
      <Annotated
        className="mt-7 gap-y-4 max-lg:max-w-[27rem]"
        note={
          <>
            Your team's code already lives on GitHub. Signing in shares your
            profile and email address; reading your team's repository is a
            separate, read-only step later.
          </>
        }
      >
        {oauthError && (
          <div
            role="alert"
            className="mb-5 rounded-control border-l-2 border-detect bg-detect-wash px-4 py-3"
          >
            <p className="text-[14px] leading-[1.5] text-detect-deep">
              {signInErrorMessage(oauthError)}
            </p>
            {/* The raw code stays on screen for every outcome, so a TA
                reading over a student's shoulder has something to search.
                Only something shaped like a Better Auth code, though: this
                is a public route and the query string is whatever the link
                said, so the page prints no other text as its own. */}
            {/^[a-z0-9_]{1,64}$/.test(oauthError) && (
              <p className="mt-1.5 font-mono text-[12px] text-ink-secondary">{oauthError}</p>
            )}
          </div>
        )}

        <div>
          {auth?.githubConfigured ? (
            <a href="/api/github/login" className={buttonClass("primary", "h-12 w-full text-[15px]")}>
              <GitHubIcon className="size-[18px]" />
              Sign in with GitHub
            </a>
          ) : (
            <>
              <button disabled className={buttonClass("primary", "h-12 w-full text-[15px]")}>
                <GitHubIcon className="size-[18px]" />
                Sign in with GitHub
              </button>
              {/* Visible, not a hover title: keyboard and touch users have no
                  hover, and a disabled control takes no focus. */}
              <p className="mt-3 text-[14px] text-ink-secondary">
                GitHub sign-in isn't configured. Ask course staff to enable it.
              </p>
            </>
          )}
        </div>
      </Annotated>

      {auth?.devAuthEnabled && (
        <details
          open={devOpen}
          onToggle={(e) => setDevToggled(e.currentTarget.open)}
          className="group mt-10 max-w-[27rem] border-t border-rule-soft pt-2"
        >
          <summary className="u-pressable -mx-2 flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 rounded-control px-2 text-[14px] font-semibold text-ink-secondary hover:text-ink [&::-webkit-details-marker]:hidden">
            <span>
              Development sign-in
              <span className="ml-2 font-normal text-ink-faint">this build only</span>
            </span>
            <HugeiconsIcon
              icon={ArrowDown01Icon}
              size={16}
              strokeWidth={1.8}
              className="shrink-0 text-ink-faint transition-transform duration-200 ease-out group-open:rotate-180 motion-reduce:transition-none"
              aria-hidden="true"
            />
          </summary>

          <form onSubmit={submit} noValidate className="pt-3 pb-1">
            <label htmlFor="dev-login" className="u-label block">
              Sign in as
            </label>
            <div className="mt-2 flex gap-2">
              <input
                id="dev-login"
                value={login}
                onChange={(e) => {
                  setLogin(e.target.value);
                  setLoginShapeError(false);
                }}
                autoComplete="username"
                autoCapitalize="none"
                spellCheck={false}
                aria-invalid={devError ? true : undefined}
                aria-describedby={devError ? "dev-login-error" : undefined}
                className="u-field min-w-0 flex-1 font-mono"
                placeholder="any-username"
              />
              <Button type="submit" variant="ghost" busy={devLogin.isPending} disabled={!login.trim()}>
                Sign in
              </Button>
            </div>
            {devError && (
              <p id="dev-login-error" role="alert" className="mt-2 text-[13.5px] text-detect-deep">
                {devError}
              </p>
            )}
            <div className="mt-5 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
              <p className="text-[13.5px] text-ink-secondary">
                Or skip ahead as a student already on a team.
              </p>
              <button
                type="button"
                disabled={devLogin.isPending}
                onClick={() => devLogin.mutate({ login: "demo", demo: true }, { onSuccess: afterSignIn })}
                className={buttonClass("quiet", "-mx-3 px-3")}
              >
                Open the demo team
                <HugeiconsIcon icon={ArrowRight01Icon} size={14} strokeWidth={1.8} aria-hidden="true" />
              </button>
            </div>
          </form>
        </details>
      )}
    </div>
  );
}
