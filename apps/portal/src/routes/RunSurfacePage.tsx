import { useState } from "react";
import { Link, useParams } from "react-router";
import { RunConsole } from "@/components/RunConsole";
import { LoadingMark, QueryError } from "@/components/Feedback";
import { Panel } from "@/components/Panel";
import { ApiRequestError } from "@/lib/api";
import { useMutateRunSurface, useRunSurface } from "@/lib/queries";
import { useRunSurfaceStream } from "@/lib/run-surface-stream";
import {
  parseSurfaceIdParam,
  runSurfaceStreamPath,
} from "@/lib/run-page-params";

export function RunSurfacePage() {
  const params = useParams();
  const surfaceId = parseSurfaceIdParam(params.surfaceId);

  if (!surfaceId.ok) {
    return (
      <div className="px-3 py-6 sm:px-6 sm:py-10">
        <Panel tone="alert" label="BAD LINK">
          <p className="max-w-prose text-[14px] text-ink">{surfaceId.reason}</p>
          <div className="mt-4 flex items-center gap-3">
            <Link
              to="/dashboard"
              className="text-[13px] text-ink underline underline-offset-4"
            >
              Back to dashboard
            </Link>
          </div>
        </Panel>
      </div>
    );
  }

  // Mounted only for a valid id, so no query or stream ever fires with a
  // malformed or missing param.
  return <RunSurfaceView surfaceId={surfaceId.id} />;
}

function RunSurfaceView({ surfaceId }: { surfaceId: string }) {
  const query = useRunSurface(surfaceId);
  const mutation = useMutateRunSurface();
  const [mutationError, setMutationError] = useState<string | null>(null);
  const stream = useRunSurfaceStream(
    query.data ?? null,
    runSurfaceStreamPath(surfaceId),
  );

  if (query.isError) return <QueryError error={query.error} retry={() => void query.refetch()} />;
  if (query.isPending || !stream.snapshot) return <LoadingMark label="Opening live bench" />;

  // Held in a const so the action callback can use it without an assertion.
  const snapshot = stream.snapshot;

  return (
    <div className="px-3 py-6 sm:px-6 sm:py-10">
      <RunConsole
        snapshot={snapshot}
        streamState={stream.state}
        busyAction={mutation.isPending ? mutation.variables?.action ?? null : null}
        error={mutationError}
        onAction={async (action) => {
          setMutationError(null);
          try {
            await mutation.mutateAsync({ surfaceId: snapshot.id, action });
          } catch (error) {
            setMutationError(error instanceof ApiRequestError ? error.message : "That action could not be completed.");
          }
        }}
      />
    </div>
  );
}
