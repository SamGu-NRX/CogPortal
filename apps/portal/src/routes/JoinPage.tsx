import { useState } from "react";
import { Navigate, useNavigate } from "react-router";
import { Button } from "@/components/Button";
import { DroppedLinkNotice } from "@/components/DroppedLinkNotice";
import { OnboardingPath } from "@/components/OnboardingPath";
import { ApiRequestError } from "@/lib/api";
import { useJoinCohort, useSession } from "@/lib/queries";

/** JoinCohortRequestSchema: 4 to 32 characters. The field stops at the
 *  server's limit so an over-long paste is visibly cut rather than refused. */
const CODE_MIN = 4;
const CODE_MAX = 32;

export function JoinPage() {
  const { data: session } = useSession();
  const navigate = useNavigate();
  const join = useJoinCohort();
  const [code, setCode] = useState("");

  if (session?.cohort) {
    return <Navigate to={session.team ? "/dashboard" : "/connect"} replace />;
  }

  const ready = code.trim().length >= CODE_MIN;

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!ready || join.isPending) return;
    join.mutate(code.trim(), {
      onSuccess: () => navigate("/connect", { replace: true }),
    });
  };

  const errorMessage =
    join.error instanceof ApiRequestError
      ? join.error.code === "cohort_code_invalid"
        ? "That code doesn't match. Check the code your instructor shared."
        : join.error.message
      : join.error
        ? "Joining failed. Try again."
        : null;

  return (
    <div className="page anim-rise [--measure:27rem]">
      <OnboardingPath current="cohort" className="max-w-[27rem]" />

      <DroppedLinkNotice className="mt-8 max-w-[27rem]" />
      <header className="mt-10 max-w-[27rem]">
        <h1 className="text-[clamp(2rem,1.5rem+2vw,2.5rem)] text-ink">Join the cohort</h1>
      </header>

      <div className="mt-8 max-w-[27rem]">
        <form onSubmit={submit}>
          <label htmlFor="join-code" className="u-label block">
            Join code
          </label>
          <input
            id="join-code"
            value={code}
            // Uppercased as typed, so what's on screen is exactly what's
            // sent. The server compares uppercase too.
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            autoFocus
            autoComplete="off"
            autoCapitalize="characters"
            autoCorrect="off"
            spellCheck={false}
            enterKeyHint="go"
            maxLength={CODE_MAX}
            aria-invalid={errorMessage ? true : undefined}
            aria-describedby={errorMessage ? "join-error" : undefined}
            className="u-field mt-2 h-16 text-center indent-[0.3em] font-mono !text-[24px] tracking-[0.3em]"
            placeholder="········"
          />
          {errorMessage && (
            <p id="join-error" role="alert" className="mt-3 text-[14px] leading-[1.5] text-detect-deep">
              {errorMessage}
            </p>
          )}
          <Button
            type="submit"
            className="mt-4 h-12 w-full"
            busy={join.isPending}
            disabled={!ready}
          >
            Join the cohort
          </Button>
        </form>
      </div>
    </div>
  );
}
