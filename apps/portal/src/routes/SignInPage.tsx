import { ArrowRight01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useState } from "react";
import { Navigate, useNavigate, useSearchParams } from "react-router";
import { nextStagePath } from "@/App";
import { Button } from "@/components/Button";
import { GitHubIcon } from "@/components/GitHubIcon";
import { ApiRequestError } from "@/lib/api";
import { useDevLogin, useSession } from "@/lib/queries";
import { pendingConnectionReturn } from "@/lib/pending-return";

export function SignInPage() {
  const { data: session } = useSession();
  const navigate = useNavigate();
  const devLogin = useDevLogin();
  const [params] = useSearchParams();
  const [login, setLogin] = useState("");

  if (session?.user) {
    return <Navigate to={pendingConnectionReturn() ?? nextStagePath(session)} replace />;
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
            <button
              disabled
              className="flex h-12 w-full cursor-not-allowed items-center justify-center gap-2.5 bg-ink/35 text-[14px] font-medium tracking-wide text-paper-raised"
              title="GitHub sign-in isn't configured. Ask course staff to enable it."
            >
              <GitHubIcon className="size-[18px]" />
              Continue with GitHub
            </button>
          )}
          {oauthError && (
            <p role="alert" className="mt-3 text-center text-[13px] text-detect-deep">
              {oauthError === "oauth_denied"
                ? "GitHub sign-in was cancelled. Sign in again when you're ready."
                : "GitHub sign-in failed. Try again."}
            </p>
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
