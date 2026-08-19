import type {
  RunStreamEventCode,
  RunSurfaceSnapshot,
} from "@cogworks/contracts/schema";
import { runSurfaceCurrentEvents } from "@cogworks/contracts/schema";
import { ACCENT_DETECT, ACCENT_INK, ACCENT_VERIFY } from "@cogworks/discord-kit/accents";
import {
  IS_COMPONENTS_V2,
  actionRow,
  button,
  linkButton,
  section,
  separator,
  surface,
  text,
  type DiscordButton,
  type DiscordContainerChild,
} from "@cogworks/discord-kit/components";
import { emojiFormatter, progressBar, type EmojiFormatter } from "@cogworks/discord-kit/emoji";
import { META_SEP, chip, elapsed, fitTextBudget, metaLine, metricValue } from "@cogworks/discord-kit/format";
import { terminalButtons, watchLiveAvailable } from "@cogworks/discord-kit/policy";
import { stageRail } from "@cogworks/discord-kit/rails";
import { effectivePhase, failureTrace, loaderLine, loaderSteps } from "@cogworks/discord-kit/steps";
import type { Env } from "../env";
import { eq } from "drizzle-orm";
import { getDb } from "../db/client";
import { runSurfaces } from "../db/schema";

const DISCORD_API = "https://discord.com/api/v10";

interface DiscordMessage {
  id: string;
}

export class DiscordRequestError extends Error {
  constructor(
    public readonly status: number,
    public readonly retryAfterMs: number | null,
  ) {
    super(`Discord message request failed with HTTP ${status}.`);
  }
}

async function discordRequest<T>(
  env: Env,
  method: "POST" | "PATCH",
  path: string,
  body: unknown,
): Promise<T> {
  if (!env.DISCORD_BOT_TOKEN) throw new Error("Discord message delivery is not configured.");
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await fetch(`${DISCORD_API}${path}`, {
      method,
      headers: {
        Authorization: `Bot ${env.DISCORD_BOT_TOKEN}`,
        "Content-Type": "application/json",
        "User-Agent": "DiscordBot (https://cogportal-dev.sillion.app, 1)",
      },
      body: JSON.stringify(body),
    });
    if (response.ok) return (await response.json()) as T;
    if (response.status === 429 && attempt === 0) {
      const rate = (await response.json().catch(() => null)) as { retry_after?: number } | null;
      const headerSeconds = Number(response.headers.get("Retry-After") ?? "0");
      const resetSeconds = Number(response.headers.get("X-RateLimit-Reset-After") ?? "0");
      const retryMs = Math.ceil(Math.max(rate?.retry_after ?? 0, headerSeconds, resetSeconds) * 1_000);
      if (retryMs > 0 && retryMs <= 2_000) {
        await new Promise((resolve) => setTimeout(resolve, retryMs));
        continue;
      }
      throw new DiscordRequestError(response.status, retryMs > 0 ? retryMs : null);
    }
    throw new DiscordRequestError(response.status, null);
  }
  throw new Error("Discord message request was rate limited.");
}

const EVENT_COPY: Record<RunStreamEventCode, string> = {
  "repository.ready": "Repository ready",
  "repository.fetching": "Fetching repository",
  "dependencies.installing": "Installing dependencies",
  "contract.checking": "Checking contract",
  "contract.passed": "Contract passed",
  "evaluation.started": "Evaluating",
  "evaluation.progress": "Evaluating",
  "scoring.started": "Scoring",
  "run.completed": "Run complete",
  "run.failed.repository": "Repository could not be prepared",
  "run.failed.dependencies": "Dependencies could not be installed",
  "run.failed.contract": "Contract check stopped",
  "run.failed.runtime": "Evaluation stopped",
  "run.failed.timeout": "Evaluation timed out",
  "run.failed.memory": "Evaluation ran out of memory",
  "run.failed.output": "Output could not be scored",
  "run.failed.scorer": "Scoring stopped",
  "run.failed.provider": "Runner unavailable",
};

function surfacePortalUrl(env: Env, surfaceId: string): string | null {
  if (!env.PUBLIC_ORIGIN) return null;
  return new URL(`/run-surfaces/${encodeURIComponent(surfaceId)}`, env.PUBLIC_ORIGIN).toString();
}

const PHASE_NOUNS: Record<string, string> = {
  queued: "preparation",
  preparing: "preparation",
  installing: "preparation",
  contract_check: "the contract check",
  evaluating: "evaluation",
  scoring: "scoring",
};

function phaseNoun(phase: string): string {
  return PHASE_NOUNS[phase] ?? phase.replaceAll("_", " ");
}

const STAGE_WORDS: Record<RunSurfaceSnapshot["stage"], string> = {
  local: "local run",
  hosted: "hosted practice",
  official: "official attempt",
  published: "published",
};

function surfaceMeta(snapshot: RunSurfaceSnapshot, lead: string): string {
  return `-# ${metaLine([
    lead,
    chip(snapshot.shortSha),
    `by ${snapshot.actor.name ?? snapshot.actor.login}`,
    chip(elapsed(snapshot.elapsedMs)),
    snapshot.dirty && "dirty worktree",
    snapshot.simulated && "simulated",
  ])}`;
}

function bestComparison(snapshot: RunSurfaceSnapshot): string | null {
  const best = snapshot.teamBest;
  const current = snapshot.primaryMetric;
  // Self-reported local metrics never qualify as observed comparisons.
  const observed = snapshot.stage !== "local";
  if (!best) return null;
  if (snapshot.status !== "succeeded" || !observed || !current) {
    return `-# team best so far ${metricValue(best)}`;
  }
  const improved = best.higherIsBetter ? current.value > best.value : current.value < best.value;
  return improved
    ? `-# a new team best, past ${metricValue(best)}`
    : `-# team best stays ${metricValue(best)}`;
}

function subscoreLines(snapshot: RunSurfaceSnapshot, fmt: EmojiFormatter): string[] {
  const extras = snapshot.metrics.filter((metric) => !metric.primary).slice(0, 4);
  return extras.map((metric) => {
    const value = chip(metricValue(metric));
    // A gauge would be misleading for values without a known 0..1 range.
    const isRate = metric.unit === null && metric.value >= 0 && metric.value <= 1;
    const gauge = isRate ? `${META_SEP}${progressBar(Math.round(metric.value * 100), 100, fmt, 5)}` : "";
    return `${value}${gauge}${META_SEP}${metric.label.toLowerCase()}`;
  });
}

export function runSurfaceMessage(env: Env, snapshot: RunSurfaceSnapshot) {
  const fmt = emojiFormatter(env.DISCORD_CLIENT_ID);
  const events = runSurfaceCurrentEvents(snapshot);
  const rail = stageRail(snapshot, fmt);
  const children: DiscordContainerChild[] = [];
  let accent = ACCENT_INK;

  if (snapshot.status === "running") {
    const bestLine = snapshot.teamBest ? `-# team best so far ${metricValue(snapshot.teamBest)}` : null;
    const head = [
      `### ${snapshot.benchmark.title}`,
      surfaceMeta(snapshot, STAGE_WORDS[snapshot.stage]),
      bestLine,
    ].filter((line): line is string => line !== null).join("\n");
    const headDisplay = text(head);
    children.push(
      watchLiveAvailable(snapshot)
        ? section(headDisplay, button(`cog:surface:${snapshot.id}:open_console`.slice(0, 100), "Watch live"))
        : headDisplay,
      separator(),
    );
    const stepLines = loaderSteps(snapshot, events).map((step) => loaderLine(step, fmt));
    children.push(text(fitTextBudget([head, rail], stepLines).join("\n")), separator(), text(rail));
  } else {
    const score = snapshot.primaryMetric ? `${META_SEP}**${metricValue(snapshot.primaryMetric)}**` : "";
    const lines: string[] = [];
    if (snapshot.status === "succeeded" && snapshot.published) {
      accent = ACCENT_VERIFY;
      lines.push(`### ${fmt("cog_star")} Published${score}`);
    } else if (snapshot.status === "succeeded") {
      accent = ACCENT_VERIFY;
      lines.push(`### ${fmt("cog_done")} Bench clear${score}`);
    } else if (snapshot.status === "failed") {
      accent = ACCENT_DETECT;
      const stopped = effectivePhase(snapshot, events);
      lines.push(`### ${fmt("cog_fail")} Stopped${stopped ? ` during ${phaseNoun(stopped)}` : " on the bench"}`);
    } else {
      const stopped = effectivePhase(snapshot, events);
      lines.push(`### Cancelled${stopped ? ` during ${phaseNoun(stopped)}` : ""}`);
    }
    lines.push(surfaceMeta(snapshot, snapshot.benchmark.title));
    if (snapshot.status === "succeeded") {
      const comparison = bestComparison(snapshot);
      if (comparison) lines.push(comparison);
    }
    if (snapshot.status === "failed" && snapshot.stage === "local") {
      lines.push("-# the useful detail is in your terminal");
    }
    if (snapshot.status === "succeeded" && snapshot.dirty && snapshot.stage === "local") {
      lines.push("-# workspace has uncommitted changes, so hosted verification needs a commit and push");
    }
    if (snapshot.status === "failed") {
      lines.push("", ...failureTrace(snapshot, events, (code) => EVENT_COPY[code], fmt));
    }
    children.push(text(lines.join("\n")));
    const breakdown = snapshot.status === "succeeded" ? subscoreLines(snapshot, fmt) : [];
    if (breakdown.length) children.push(separator(false), text(breakdown.join("\n")));
    children.push(separator(), text(rail));

    const buttons: DiscordButton[] = terminalButtons(snapshot).map((spec) =>
      button(`cog:surface:${snapshot.id}:${spec.action}`.slice(0, 100), spec.label, spec.style),
    );
    const target = surfacePortalUrl(env, snapshot.id);
    if (target) buttons.push(linkButton(target, "Cog*Portal"));
    if (buttons.length) children.push(separator(false), actionRow(...buttons));
  }

  return {
    flags: IS_COMPONENTS_V2,
    components: [{ type: 17 as const, accent_color: accent, components: children }],
    allowed_mentions: { parse: [] as string[] },
  };
}

function nonce(snapshot: RunSurfaceSnapshot, generation: number): string {
  return `${snapshot.id.slice(-18)}${generation.toString(36)}`.slice(0, 25);
}

export async function syncRunSurfaceMessage(env: Env, snapshot: RunSurfaceSnapshot): Promise<"updated" | "created" | "unbound"> {
  const db = getDb(env);
  const [surface] = await db.select().from(runSurfaces).where(eq(runSurfaces.id, snapshot.id)).limit(1);
  if (!surface?.discordChannelId) return "unbound";
  if (surface.discordMessageId) {
    try {
      await discordRequest<DiscordMessage>(
        env,
        "PATCH",
        `/channels/${encodeURIComponent(surface.discordChannelId)}/messages/${encodeURIComponent(surface.discordMessageId)}`,
        runSurfaceMessage(env, snapshot),
      );
      return "updated";
    } catch (error) {
      if (!(error instanceof DiscordRequestError) || error.status !== 404) throw error;
      await db
        .update(runSurfaces)
        .set({ discordMessageId: null, discordNonceGeneration: surface.discordNonceGeneration + 1 })
        .where(eq(runSurfaces.id, surface.id));
      surface.discordMessageId = null;
      surface.discordNonceGeneration += 1;
    }
  }
  const body = {
    ...runSurfaceMessage(env, snapshot),
    nonce: nonce(snapshot, surface.discordNonceGeneration),
    enforce_nonce: true,
  };
  const created = await discordRequest<DiscordMessage>(
    env,
    "POST",
    `/channels/${encodeURIComponent(surface.discordChannelId)}/messages`,
    body,
  );
  if (!/^\d{10,24}$/.test(created.id)) throw new Error("Discord returned an invalid message ID.");
  await db.update(runSurfaces).set({ discordMessageId: created.id }).where(eq(runSurfaces.id, surface.id));
  return "created";
}

/**
 * Post a plain message into a team's channel.
 *
 * Separate from `syncRunSurfaceMessage`, which edits one message in place for
 * the lifetime of a run. This posts once and never comes back to it, which is
 * what an observation about the team rather than about a run should do.
 *
 * The caller owns not sending the same thing twice; there is no nonce here
 * because these are not retried.
 */
export async function postTeamMessage(
  env: Env,
  channelId: string,
  body: string,
): Promise<void> {
  await discordRequest<DiscordMessage>(
    env,
    "POST",
    `/channels/${encodeURIComponent(channelId)}/messages`,
    {
      flags: IS_COMPONENTS_V2,
      components: [surface([text(body)], ACCENT_INK)],
    },
  );
}
