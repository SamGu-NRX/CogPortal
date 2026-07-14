import { useState } from "react";
import { Navigate, useNavigate } from "react-router";
import { Button } from "@/components/Button";
import { ApiRequestError } from "@/lib/api";
import { useJoinCohort, useSession } from "@/lib/queries";

export function JoinPage() {
  const { data: session } = useSession();
  const navigate = useNavigate();
  const join = useJoinCohort();
  const [code, setCode] = useState("");

  if (session?.cohort) {
    return <Navigate to={session.team ? "/dashboard" : "/connect"} replace />;
  }

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (code.trim().length < 4 || join.isPending) return;
    join.mutate(code.trim().toUpperCase(), {
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
    <div className="anim-rise flex flex-1 items-center justify-center py-10">
      <div className="w-full max-w-sm">
        <h1 className="text-3xl">Join the cohort</h1>
        <p className="mt-2 text-[14px] text-ink-secondary">
          Enter the join code from your instructor. You do this once.
        </p>

        <form onSubmit={submit} className="mt-7">
          <label htmlFor="join-code" className="sr-only">
            Join code
          </label>
          <input
            id="join-code"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            autoFocus
            autoComplete="off"
            spellCheck={false}
            aria-invalid={errorMessage ? true : undefined}
            aria-describedby={errorMessage ? "join-error" : undefined}
            className="h-13 w-full border border-rule bg-paper-sunken px-4 text-center font-mono text-xl tracking-[0.35em] text-ink uppercase placeholder:tracking-[0.2em] placeholder:text-ink-faint"
            placeholder="········"
          />
          {errorMessage && (
            <p id="join-error" role="alert" className="mt-3 text-[13px] text-detect-deep">
              {errorMessage}
            </p>
          )}
          <Button
            type="submit"
            className="mt-4 w-full"
            busy={join.isPending}
            disabled={code.trim().length < 4}
          >
            Join
          </Button>
        </form>
      </div>
    </div>
  );
}
