import { useEffect, useState } from "react";
import {
  RunSurfaceSnapshotSchema,
  shouldReplaceRunSurfaceSnapshot,
  type RunSurfaceSnapshot,
} from "@cogworks/contracts/schema";

export type StreamState = "connecting" | "live" | "reconnecting" | "closed";

function websocketUrl(path: string): string {
  const url = new URL(path, window.location.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

export function useRunSurfaceStream(
  initial: RunSurfaceSnapshot | null,
  path: string | null,
): { snapshot: RunSurfaceSnapshot | null; state: StreamState } {
  const [snapshot, setSnapshot] = useState(initial);
  const [state, setState] = useState<StreamState>(path ? "connecting" : "closed");

  useEffect(() => {
    setSnapshot((current) => !initial || !current || current.id !== initial.id || shouldReplaceRunSurfaceSnapshot(current, initial)
      ? initial : current);
  }, [initial]);

  useEffect(() => {
    if (!path) {
      setState("closed");
      return;
    }
    let socket: WebSocket | null = null;
    let stopped = false;
    let retry = 0;
    let timer: number | undefined;

    const connect = () => {
      if (stopped) return;
      setState(retry ? "reconnecting" : "connecting");
      socket = new WebSocket(websocketUrl(path));
      socket.addEventListener("open", () => {
        if (stopped) return;
        retry = 0;
        setState("live");
      });
      socket.addEventListener("message", (event) => {
        try {
          const parsed = RunSurfaceSnapshotSchema.parse(JSON.parse(String(event.data)));
          if (stopped || parsed.id !== initial?.id) return;
          setSnapshot((current) => !current || current.id !== parsed.id || shouldReplaceRunSurfaceSnapshot(current, parsed)
            ? parsed : current);
        } catch {
          // Malformed frames cannot replace a validated snapshot.
        }
      });
      socket.addEventListener("close", () => {
        if (stopped) return;
        retry += 1;
        setState("reconnecting");
        timer = window.setTimeout(connect, Math.min(8_000, 500 * 2 ** Math.min(retry, 4)));
      });
      socket.addEventListener("error", () => socket?.close());
    };

    connect();
    return () => {
      stopped = true;
      if (timer !== undefined) window.clearTimeout(timer);
      socket?.close();
    };
  }, [path, initial?.id]);

  // Show an action response immediately, before effects can process a queued frame.
  const current = !initial || !snapshot || initial.id !== snapshot.id || shouldReplaceRunSurfaceSnapshot(snapshot, initial)
    ? initial : snapshot;
  return { snapshot: current, state };
}
