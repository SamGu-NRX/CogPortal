import { useState } from "react";
import { Link, useParams } from "react-router";
import { RunConsole } from "@/components/RunConsole";
import { LoadingMark, QueryError } from "@/components/Feedback";
import { ApiRequestError } from "@/lib/api";
import { useMutateRunSurface, useRunSurface } from "@/lib/queries";
import { useRunSurfaceStream } from "@/lib/run-surface-stream";

export function RunSurfacePage() {
  const { surfaceId = "" } = useParams();
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
      <div className="px-3 py-6 sm:px-6 sm:py-10">
        <QueryError error={query.error} retry={() => void query.refetch()}>
          <Link
            to="/dashboard"
            className="u-pressable inline-flex min-h-11 items-center border border-rule px-5 font-mono text-[11.5px] tracking-[0.09em] text-ink uppercase hover:border-ink-secondary"
          >
            Back to dashboard
          </Link>
        </QueryError>
      </div>
    );
  }
  if (query.isPending || !stream.snapshot) return <LoadingMark label="Opening live bench" />;

  return (
    <div className="px-3 py-6 sm:px-6 sm:py-10">
      <RunConsole
        snapshot={stream.snapshot}
        streamState={stream.state}
        busyAction={mutation.isPending ? mutation.variables?.action ?? null : null}
        error={mutationError}
        onAction={async (action) => {
          setMutationError(null);
          try {
            await mutation.mutateAsync({ surfaceId: stream.snapshot!.id, action });
          } catch (error) {
            setMutationError(error instanceof ApiRequestError ? error.message : "That action could not be completed.");
          }
        }}
      />
    </div>
  );
}
