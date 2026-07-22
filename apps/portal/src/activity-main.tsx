import { StrictMode, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { Common, DiscordSDK, Events } from "@discord/embedded-app-sdk";
import { z } from "zod";
import {
  RunSurfaceSnapshotSchema,
  type RunSurfaceSnapshot,
} from "@cogworks/contracts/schema";

import "@fontsource-variable/source-serif-4/index.css";
import "@fontsource/ibm-plex-sans/400.css";
import "@fontsource/ibm-plex-sans/500.css";
import "@fontsource/ibm-plex-sans/600.css";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";
import "./styles/app.css";

import { RunConsole } from "@/components/RunConsole";
import { useRunSurfaceStream } from "@/lib/run-surface-stream";
import { clientEnv } from "./env.client";

const CLIENT_ID = clientEnv.VITE_DISCORD_CLIENT_ID;
document.title = "Cog · Live bench";
const embedded =
  window.location.hostname.endsWith(".discordsays.com") ||
  new URLSearchParams(window.location.search).has("frame_id");
const API_PREFIX = embedded ? "/.proxy/api" : "/api";
const sdk = embedded ? new DiscordSDK(CLIENT_ID) : null;

const SessionSchema = z.discriminatedUnion("linked", [
  z.object({ linked: z.literal(false), linkUrl: z.string().url() }),
  z.object({
    linked: z.literal(true),
    githubLogin: z.string(),
    team: z.object({ id: z.string(), name: z.string(), discordChannelId: z.string().nullable() }),
  }),
]);
type ActivitySession = z.infer<typeof SessionSchema>;
type ActivityLayoutMode = -1 | 0 | 1 | 2;

async function jsonRequest<T>(
  path: string,
  schema: z.ZodType<T>,
  init?: { method?: string; body?: unknown },
): Promise<T> {
  const response = await fetch(`${API_PREFIX}${path}`, {
    method: init?.method ?? "GET",
    credentials: "same-origin",
    headers: init?.body === undefined ? undefined : { "Content-Type": "application/json" },
    body: init?.body === undefined ? undefined : JSON.stringify(init.body),
  });
  if (!response.ok) {
    let message = "The live bench could not be reached.";
    try {
      const body = z.object({ error: z.object({ message: z.string() }) }).parse(await response.json());
      message = body.error.message;
    } catch {
      // Use the calm fallback above.
    }
    throw new Error(message);
  }
  return schema.parse(await response.json());
}

function ActivityHeader({
  session,
  surfaces,
  selectedId,
  onSelect,
  compact,
}: {
  session: Extract<ActivitySession, { linked: true }>;
  surfaces: RunSurfaceSnapshot[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  compact: boolean;
}) {
  return (
    <header className="activity-header z-20 border-b border-rule bg-paper/95 backdrop-blur-sm">
      <div className="mx-auto flex max-w-[72rem] items-center justify-between gap-3">
        <div className="min-w-0">
          <div className={`font-serif font-semibold leading-none ${compact ? "text-base" : "text-lg"}`}>Cog<span className="text-detect">*</span>Works</div>
          {!compact && <div className="mt-1 truncate font-mono text-[10px] uppercase tracking-[0.08em] text-ink-faint">{session.team.name} · live bench</div>}
        </div>
        {surfaces.length > 0 && !compact && (
          <label className="flex min-w-0 items-center gap-2">
            <span className="sr-only">Choose a recent run</span>
            <select
              value={selectedId ?? ""}
              className="min-h-10 max-w-[13rem] border border-rule bg-paper-raised px-2 font-mono text-[11px] text-ink focus-visible:outline-offset-1"
              onChange={(event) => onSelect(event.target.value)}
            >
              {surfaces.map((surface) => (
                <option key={surface.id} value={surface.id}>
                  {surface.benchmark.title} · {surface.shortSha}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
    </header>
  );
}

function ActivityApp() {
  const [session, setSession] = useState<ActivitySession | null>(null);
  const [surfaces, setSurfaces] = useState<RunSurfaceSnapshot[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [startupError, setStartupError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [mutation, setMutation] = useState<"verify_hosted" | "promote_official" | "publish_result" | "rerun_hosted" | null>(null);
  const [layoutMode, setLayoutMode] = useState<ActivityLayoutMode>(Common.LayoutModeTypeObject.FOCUSED);

  useEffect(() => {
    if (!sdk) return;
    let active = true;
    let subscribed = false;
    const onLayoutMode = ({ layout_mode }: { layout_mode: ActivityLayoutMode }) => {
      if (active) setLayoutMode(layout_mode);
    };
    void sdk.ready().then(async () => {
      if (!active) return;
      await sdk.subscribe(Events.ACTIVITY_LAYOUT_MODE_UPDATE, onLayoutMode);
      if (!active) {
        await sdk.unsubscribe(Events.ACTIVITY_LAYOUT_MODE_UPDATE, onLayoutMode);
        return;
      }
      subscribed = true;
    }).catch(() => {
      // Focused is the safe fallback when an older client does not emit layout updates.
    });
    return () => {
      active = false;
      if (subscribed) void sdk.unsubscribe(Events.ACTIVITY_LAYOUT_MODE_UPDATE, onLayoutMode).catch(() => undefined);
    };
  }, []);

  useEffect(() => {
    if (!sdk) {
      setLoading(false);
      return;
    }
    let active = true;
    void (async () => {
      try {
        await sdk.ready();
        const state = await jsonRequest("/activity/oauth/state", z.object({ state: z.string() }));
        const authorization = await sdk.commands.authorize({
          client_id: CLIENT_ID,
          response_type: "code",
          state: state.state,
          prompt: "none",
          scope: ["identify"],
        });
        const token = await jsonRequest(
          "/activity/oauth/token",
          z.object({
            accessToken: z.string(),
            user: z.object({ id: z.string(), username: z.string(), globalName: z.string().nullable() }),
          }),
          { method: "POST", body: { code: authorization.code, state: state.state } },
        );
        await sdk.commands.authenticate({ access_token: token.accessToken });
        const nextSession = await jsonRequest("/activity/session", SessionSchema);
        if (!active) return;
        setSession(nextSession);
        if (nextSession.linked) {
          const nextSurfaces = await jsonRequest(
            "/activity/run-surfaces",
            z.array(RunSurfaceSnapshotSchema),
          );
          if (!active) return;
          setSurfaces(nextSurfaces);
          setSelectedId(nextSurfaces[0]?.id ?? null);
        }
      } catch (caught) {
        if (active) setStartupError(caught instanceof Error ? caught.message : "The Activity could not open.");
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => { active = false; };
  }, []);

  const selected = useMemo(
    () => surfaces.find((surface) => surface.id === selectedId) ?? null,
    [selectedId, surfaces],
  );
  const stream = useRunSurfaceStream(
    selected,
    selectedId ? `${API_PREFIX}/activity/run-surfaces/${encodeURIComponent(selectedId)}/stream` : null,
  );
  const compact = layoutMode === Common.LayoutModeTypeObject.PIP || layoutMode === Common.LayoutModeTypeObject.GRID;

  if (!embedded) {
    return (
      <main className="activity-safe grid min-h-dvh place-items-center p-5">
        <section className="w-full max-w-lg border border-rule bg-paper-raised p-7 shadow-[0_18px_55px_rgb(28_38_55/0.08)]">
          <div className="u-kicker">Discord Activity</div>
          <h1 className="mt-3 text-4xl">Open the live bench from Discord.</h1>
          <p className="mt-4 text-[14px] text-ink-secondary">Use <code>/cog</code> in your team channel, then choose <strong>Open live console</strong>. Your linked Discord identity decides which team surfaces you can see.</p>
          <a className="mt-6 inline-flex min-h-11 items-center bg-ink px-5 text-[13px] font-medium text-paper-raised" href="https://cogportal-dev.sillion.app">Open Cog*Portal</a>
        </section>
      </main>
    );
  }

  if (loading) {
    return <main className="activity-safe grid min-h-dvh place-items-center"><div role="status" className="u-kicker"><span className="anim-live mr-2 inline-block size-2 bg-detect" />Opening the bench…</div></main>;
  }
  if (startupError || !session) {
    return <main className="activity-safe grid min-h-dvh place-items-center p-5"><section className="max-w-md border-l-2 border-detect pl-5"><div className="u-kicker">Could not open</div><h1 className="mt-2 text-3xl">The bench is still here.</h1><p className="mt-3 text-[14px] text-ink-secondary">{startupError ?? "Close the Activity and open it again."}</p></section></main>;
  }
  if (!session.linked) {
    return (
      <main className="activity-safe grid min-h-dvh place-items-center p-5">
        <section className="w-full max-w-lg border border-rule bg-paper-raised p-7">
          <div className="u-kicker">One connection</div>
          <h1 className="mt-3 text-4xl">Link Cog*Portal to see your team's bench.</h1>
          <p className="mt-4 text-[14px] text-ink-secondary">Discord is attached to your existing GitHub-first portal account. No repository access or Discord login is stored on your laptop.</p>
          <button type="button" className="mt-6 min-h-11 bg-ink px-5 text-[13px] font-medium text-paper-raised" onClick={() => {
            if (sdk) void sdk.commands.openExternalLink({ url: session.linkUrl });
          }}>Link Cog*Portal ↗</button>
        </section>
      </main>
    );
  }

  return (
    <div className="activity-shell" data-layout-mode={layoutMode}>
      <ActivityHeader session={session} surfaces={surfaces} selectedId={selectedId} onSelect={setSelectedId} compact={compact} />
      <main className="activity-scroller">
        {stream.snapshot ? (
          <RunConsole
            embedded
            compact={compact}
            snapshot={stream.snapshot}
            streamState={stream.state}
            busyAction={mutation}
            error={actionError}
            onOpenPortal={() => {
              const url = `https://cogportal-dev.sillion.app/run-surfaces/${stream.snapshot!.id}`;
              if (sdk) void sdk.commands.openExternalLink({ url });
            }}
            onAction={async (action) => {
              setMutation(action);
              setActionError(null);
              try {
                const next = await jsonRequest(
                  `/activity/run-surfaces/${encodeURIComponent(stream.snapshot!.id)}/actions/${action}`,
                  RunSurfaceSnapshotSchema,
                  { method: "POST" },
                );
                setSurfaces((items) => [next, ...items.filter((item) => item.id !== next.id)]);
                setSelectedId(next.id);
              } catch (caught) {
                setActionError(caught instanceof Error ? caught.message : "That action could not be completed.");
              } finally {
                setMutation(null);
              }
            }}
          />
        ) : (
          <section className="mx-auto mt-[12vh] max-w-lg border border-rule bg-paper-raised p-7 text-center">
            <div className="u-kicker">Bench ready</div>
            <h1 className="mt-3 text-4xl">No shared runs yet.</h1>
            <p className="mt-4 text-[14px] text-ink-secondary">Start with <code>cogworks run --live</code>. Cog will keep one message and this console current for the team.</p>
          </section>
        )}
      </main>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ActivityApp />
  </StrictMode>,
);
