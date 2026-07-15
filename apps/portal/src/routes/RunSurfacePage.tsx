import { useState } from "react";
import { useParams } from "react-router";
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

  if (query.isError) return <QueryError error={query.error} retry={() => void query.refetch()} />;
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
