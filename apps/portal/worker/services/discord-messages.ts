import type { LocalRunPhase, Metric } from "@cogworks/contracts/schema";
import type { Env } from "../env";

const DISCORD_API = "https://discord.com/api/v10";
const COMPONENTS_V2 = 1 << 15;
const ACCENT_INK = 0x1c2637;
const ACCENT_DETECT = 0xc63d2f;
const ACCENT_VERIFY = 0x2e6b4f;
const PHASES: LocalRunPhase[] = ["preparing", "contract_check", "evaluating", "scoring"];

export interface LocalRunBubble {
  teamName: string;
  benchmarkId: string;
  benchmarkTitle: string;
  githubLogin: string;
  sha: string;
  dirty: boolean;
  phase: LocalRunPhase;
  status: "running" | "succeeded" | "failed";
  primaryMetric?: Metric | null;
  failureDetail?: string | null;
}

interface DiscordMessage {
  id: string;
}

function portalUrl(env: Env, benchmarkId: string): string | null {
  if (!env.PUBLIC_ORIGIN) return null;
  const url = new URL("/dashboard", env.PUBLIC_ORIGIN);
  url.searchParams.set("benchmark", benchmarkId);
  url.searchParams.set("from", "discord-live-run");
  return url.toString();
}

function metricValue(metric: Metric): string {
  const value = metric.value.toFixed(metric.precision);
  return metric.unit ? `${value} ${metric.unit}` : value;
}

function phaseRail(run: LocalRunBubble): string {
  const active = PHASES.indexOf(run.phase);
  return PHASES.map((phase, index) => {
    const label: Record<LocalRunPhase, string> = {
      preparing: "prepare",
      contract_check: "check",
      evaluating: "evaluate",
      scoring: "score",
    };
    const mark =
      run.status === "succeeded" || index < active
        ? "✓"
        : run.status === "failed" && index === active
          ? "×"
          : index === active
            ? "●"
            : "○";
    return `${mark} ${label[phase]}`;
  }).join("  →  ");
}

function statusCopy(run: LocalRunBubble): string {
  if (run.status === "succeeded") {
    const result = run.primaryMetric ? ` **${metricValue(run.primaryMetric)}**` : "";
    return `**Bench cleared. Nice work.**${result}`;
  }
  if (run.status === "failed") {
    return `**Hit a snag during ${run.phase.replace("_", " ")}.**\n${run.failureDetail ?? "Open CogBench for the local error."}`;
  }
  const labels: Record<LocalRunPhase, string> = {
    preparing: "Setting out the tools…",
    contract_check: "Checking the submission contract…",
    evaluating: "Running the public cases…",
    scoring: "Reading the gauges…",
  };
  return `**${labels[run.phase]}**`;
}

export function localRunMessage(env: Env, run: LocalRunBubble) {
  const children: Array<Record<string, unknown>> = [
    {
      type: 10,
      content: [
        `## ${run.status === "running" ? "◉" : run.status === "succeeded" ? "✓" : "×"} Local run · ${run.benchmarkTitle}`,
        `**${run.teamName}** · @${run.githubLogin} · \`${run.sha.slice(0, 7)}\`${run.dirty ? " · dirty worktree" : ""}`,
        "",
        phaseRail(run),
        "",
        statusCopy(run),
        "",
        "-# Local · self-reported · source code and raw outputs stay on this device",
      ].join("\n").slice(0, 4_000),
    },
  ];
  const target = portalUrl(env, run.benchmarkId);
  if (target && run.status !== "running") {
    children.push(
      { type: 14, divider: true, spacing: 1 },
      {
        type: 1,
        components: [
          {
            type: 2,
            style: 5,
            label: run.status === "succeeded" && !run.dirty ? "Verify hosted ↗" : "Open CogPortal ↗",
            url: target,
          },
        ],
      },
    );
  }
  return {
    flags: COMPONENTS_V2,
    components: [
      {
        type: 17,
        accent_color:
          run.status === "succeeded"
            ? ACCENT_VERIFY
            : run.status === "failed"
              ? ACCENT_DETECT
              : ACCENT_INK,
        components: children,
      },
    ],
    allowed_mentions: { parse: [] as string[] },
  };
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
      const retryMs = Math.ceil((rate?.retry_after ?? 0) * 1_000);
      if (retryMs > 0 && retryMs <= 2_000) {
        await new Promise((resolve) => setTimeout(resolve, retryMs));
        continue;
      }
    }
    throw new Error(`Discord message request failed with HTTP ${response.status}.`);
  }
  throw new Error("Discord message request was rate limited.");
}

export async function createLocalRunMessage(
  env: Env,
  channelId: string,
  run: LocalRunBubble,
): Promise<string> {
  const message = await discordRequest<DiscordMessage>(
    env,
    "POST",
    `/channels/${encodeURIComponent(channelId)}/messages`,
    localRunMessage(env, run),
  );
  if (!/^\d{10,24}$/.test(message.id)) throw new Error("Discord returned an invalid message ID.");
  return message.id;
}

export async function updateLocalRunMessage(
  env: Env,
  channelId: string,
  messageId: string,
  run: LocalRunBubble,
): Promise<void> {
  await discordRequest<DiscordMessage>(
    env,
    "PATCH",
    `/channels/${encodeURIComponent(channelId)}/messages/${encodeURIComponent(messageId)}`,
    localRunMessage(env, run),
  );
}
