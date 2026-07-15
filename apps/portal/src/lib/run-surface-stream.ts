import { useEffect, useState } from "react";
import {
  RunSurfaceSnapshotSchema,
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

  useEffect(() => setSnapshot(initial), [initial]);

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
        retry = 0;
        setState("live");
      });
      socket.addEventListener("message", (event) => {
        try {
          const parsed = RunSurfaceSnapshotSchema.parse(JSON.parse(String(event.data)));
          setSnapshot(parsed);
        } catch {
          // Ignore malformed or stale frames; the next authoritative snapshot wins.
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
  }, [path]);

  return { snapshot, state };
}
