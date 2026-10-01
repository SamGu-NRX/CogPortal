import { useState } from "react";
import { ArrowLeft01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Link, useNavigate, useParams } from "react-router";
import { buttonClass } from "@/components/Button";
import { RunConsole } from "@/components/RunConsole";
import { LoadingMark, QueryError } from "@/components/Feedback";
import { ApiRequestError } from "@/lib/api";
import { useMutateRunSurface, useRunSurface } from "@/lib/queries";
import { useRunSurfaceStream } from "@/lib/run-surface-stream";

export function RunSurfacePage() {
  const { surfaceId = "" } = useParams();
  const navigate = useNavigate();
  const query = useRunSurface(surfaceId);
  const mutation = useMutateRunSurface();
  const [mutationError, setMutationError] = useState<string | null>(null);
  const stream = useRunSurfaceStream(
    query.data ?? null,
    surfaceId ? `/api/run-surfaces/${encodeURIComponent(surfaceId)}/stream` : null,
  );

  // A surface belonging to another team is reported as a 404 on purpose
  // (worker/routes/run-surfaces.ts:19), so a stale link from Discord lands
  // here often. The dashboard is a nearer destination than the front page.
  if (query.isError) {
    return (
      <div className="py-14">
        <QueryError error={query.error} retry={() => void query.refetch()}>
          <Link to="/dashboard" className={buttonClass("ghost")}>
            Back to your runs
          </Link>
        </QueryError>
      </div>
    );
  }
  if (query.isPending || !stream.snapshot) return <LoadingMark label="Opening live bench" />;

  return (
    <div className="page !pt-6 sm:!pt-8">
      {/* A link from Discord lands here with nothing else on the page
          pointing anywhere, so the way back to the team's runs is named. */}
      <Link
        to="/dashboard"
        className="u-pressable -ml-1 mb-2 inline-flex min-h-11 items-center gap-1 px-1 text-[14px] font-semibold text-ink-secondary hover:text-ink"
      >
        <HugeiconsIcon icon={ArrowLeft01Icon} size={15} strokeWidth={2} aria-hidden="true" />
        Runs
      </Link>
      <RunConsole
        snapshot={stream.snapshot}
        streamState={stream.state}
        busyAction={mutation.isPending ? mutation.variables?.action ?? null : null}
        error={mutationError}
        onOpenRun={(runId) => navigate(`/runs/${encodeURIComponent(runId)}`)}
        onAction={async (input) => {
          setMutationError(null);
          try {
            const next = await mutation.mutateAsync(input);
            // A rerun answers with the successor surface; staying on the old
            // id would keep showing the finished run it was created from.
            if (next.id !== surfaceId) {
              navigate(`/run-surfaces/${encodeURIComponent(next.id)}`);
            }
          } catch (error) {
            setMutationError(error instanceof ApiRequestError ? error.message : "That action could not be completed.");
          }
        }}
      />
    </div>
  );
}
