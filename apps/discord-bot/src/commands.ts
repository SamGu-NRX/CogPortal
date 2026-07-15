import type { PortalRpcContract } from "@cogworks/contracts/discord";
import type { Metric, RunStatus, RunSummary } from "@cogworks/contracts/schema";
import {
  ACCENT_DETECT,
  ACCENT_INK,
  ACCENT_VERIFY,
  INTERACTION_MESSAGE_COMPONENT,
  actionRow,
  button,
  componentMessage,
  interactionUser,
  legacySubcommand,
  linkButton,
  message,
  separator,
  stringOption,
  surface,
  text,
  type DiscordButton,
  type DiscordContainerChild,
  type DiscordInteraction,
  type DiscordUser,
  type InteractionResponse,
} from "./interaction.ts";

type View = "home" | "leaderboard" | "benchmarks" | "local" | "connect";
type RequestedView = View | "share:leaderboard" | "bind-channel" | "bind-channel:confirm";

const VIEW_IDS = new Set<View>(["home", "leaderboard", "benchmarks", "local", "connect"]);

function metricValue(metric: Metric): string {
  const value = metric.value.toFixed(metric.precision);
  return metric.unit ? `${value} ${metric.unit}` : value;
}

function friendlyStatus(status: RunStatus): string {
  const labels: Record<RunStatus, string> = {
    queued: "waiting for a runner",
    preparing: "preparing the workspace",
    installing: "installing the project",
    contract_check: "checking the benchmark contract",
    evaluating: "evaluating cases",
    scoring: "scoring the run",
    succeeded: "complete",
    failed: "needs attention",
    cancelled: "cancelled",
  };
  return labels[status];
}

function runLine(label: string, run: RunSummary | null): string {
  if (!run) return `○ **${label}** · nothing yet`;
  const active = !["succeeded", "failed", "cancelled"].includes(run.status);
  const mark = run.status === "succeeded" ? "✓" : active ? "◉" : "○";
  const score = run.primaryMetric ? ` · **${metricValue(run.primaryMetric)}**` : "";
  return `${mark} **${label}** · ${friendlyStatus(run.status)} · \`${run.shortSha}\`${score}`;
}

function safePortalUrl(origin: string | undefined, path: string): string | null {
  if (!origin) return null;
  try {
    const url = new URL(path, origin);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function navigation(active: View, portalOrigin?: string): ReturnType<typeof actionRow> {
  const buttons: DiscordButton[] = [
    button("cog:home", "Home", active === "home" ? 1 : 2, active === "home"),
    button("cog:leaderboard", "Leaderboard", active === "leaderboard" ? 1 : 2, active === "leaderboard"),
    button("cog:benchmarks", "Benchmarks", active === "benchmarks" ? 1 : 2, active === "benchmarks"),
    button("cog:local", "Local", active === "local" ? 1 : 2, active === "local"),
  ];
  const portalUrl = safePortalUrl(portalOrigin, "/dashboard");
  if (portalUrl) buttons.push(linkButton(portalUrl, "CogPortal ↗"));
  return actionRow(...buttons);
}

function updateFor(interaction: DiscordInteraction): boolean {
  return interaction.type === INTERACTION_MESSAGE_COMPONENT;
}

function displayName(user: DiscordUser): string {
  return user.global_name?.trim() || user.username;
}

function discordIdentity(user: DiscordUser): string {
  return user.global_name ? `${user.global_name} (@${user.username})` : `@${user.username}`;
}

async function homeView(
  interaction: DiscordInteraction,
  portal: PortalRpcContract,
  guildId: string,
  user: DiscordUser,
  portalOrigin?: string,
): Promise<InteractionResponse> {
  const status = await portal.getTeamStatus(guildId, user.id);
  if (!status.linked) return connectView(interaction, portal, guildId, user);

  if (!status.team) {
    const portalUrl = safePortalUrl(portalOrigin, "/connect");
    const actions = portalUrl
      ? actionRow(linkButton(portalUrl, "Choose your repository ↗"), button("cog:home", "Refresh", 2))
      : actionRow(button("cog:home", "Refresh", 1));
    return componentMessage(
      [
        surface(
          [
            text(
              `## One small step left\nYou're linked as **${status.githubLogin}**. Choose your team's repository in CogPortal, then come back and refresh.`,
            ),
            separator(),
            actions,
          ],
          ACCENT_DETECT,
        ),
      ],
      { update: updateFor(interaction) },
    );
  }

  const channelLine = status.discordChannelId
    ? `Live runs → <#${status.discordChannelId}>`
    : status.canManageDiscordChannel
      ? "Live runs are ready; choose this team's Discord channel below."
      : "Live runs are ready once a team creator or maintainer chooses the team channel.";
  const channelAction =
    !status.discordChannelId && status.canManageDiscordChannel && interaction.channel_id
      ? [separator(), actionRow(button("cog:bind-channel", "Use this as our team channel", 1))]
      : [];

  return componentMessage(
    [
      surface(
        [
          text(
            [
              `## ${status.team.name} · lab bench`,
              `Good to see you, ${displayName(user)}.`,
              status.team.repo ? `\`${status.team.repo.fullName}\`` : "_Repository not connected yet_",
              "",
              runLine("In progress", status.activeRun),
              runLine("Hosted practice", status.latestHosted),
              runLine("Official best", status.latestOfficial),
              "",
              channelLine,
              "",
              "-# Private to you · quiet by default · refreshed when you ask",
            ].join("\n"),
          ),
          ...channelAction,
          separator(),
          navigation("home", portalOrigin),
        ],
        ACCENT_VERIFY,
      ),
    ],
    { update: updateFor(interaction) },
  );
}

async function connectView(
  interaction: DiscordInteraction,
  portal: PortalRpcContract,
  guildId: string,
  user: DiscordUser,
): Promise<InteractionResponse> {
  const start = await portal.createDiscordLink(guildId, user.id, discordIdentity(user));
  if (start.alreadyLinked) return homeView(interaction, portal, guildId, user);
  if (!start.url) return message("I couldn't make a connection link just now. Nothing changed—try again in a moment.");

  return componentMessage(
    [
      surface(
        [
          text(
            [
              `## Hi ${displayName(user)} — I'm Cog`,
              "I keep your team's benchmarks, runs, and leaderboard close by.",
              "",
              "Link Discord to your existing CogPortal account once, confirm exactly what Discord can see, and you're in. The private link works once and expires in **10 minutes**.",
              "",
              "-# Cog cannot read your source code or start official evaluations.",
            ].join("\n"),
          ),
          separator(),
          actionRow(
            linkButton(start.url, "Link to CogPortal ↗"),
            button("cog:home", "I've connected", 1),
          ),
        ],
        ACCENT_DETECT,
      ),
    ],
    { update: updateFor(interaction) },
  );
}

async function benchmarksView(
  interaction: DiscordInteraction,
  portal: PortalRpcContract,
  guildId: string,
  portalOrigin?: string,
): Promise<InteractionResponse> {
  const benchmarks = await portal.getBenchmarks(guildId);
  const lines = benchmarks.map(
    (benchmark) => `${benchmark.active ? "●" : "○"} **${benchmark.title}**\n-# ${benchmark.summary}`,
  );
  return componentMessage(
    [
      surface(
        [
          text(
            `## Benchmarks on the bench\n${lines.length ? lines.join("\n\n") : "Nothing is published yet. The bench is getting set up."}`,
          ),
          separator(),
          navigation("benchmarks", portalOrigin),
        ],
        ACCENT_INK,
      ),
    ],
    { update: updateFor(interaction) },
  );
}

async function leaderboardView(
  interaction: DiscordInteraction,
  portal: PortalRpcContract,
  guildId: string,
  portalOrigin?: string,
  shared = false,
): Promise<InteractionResponse> {
  const leaderboard = await portal.getLeaderboard(guildId);
  const medals = ["🥇", "🥈", "🥉"];
  const lines = leaderboard.entries.slice(0, 10).map((entry, index) => {
    const rank = medals[index] ?? `**${entry.rank}.**`;
    return `${rank} **${entry.teamName}** · ${metricValue(entry.primaryMetric)} · \`${entry.shortSha}\``;
  });
  const body = lines.length
    ? lines.join("\n")
    : "The board is wide open. Your team could set the first mark.";
  const children: DiscordContainerChild[] = [
    text(`## ${leaderboard.benchmark.title} · leaderboard\n${body}`),
  ];
  if (!shared) {
    children.push(
      separator(),
      actionRow(
        button("cog:share:leaderboard", "Share in channel", 1),
        ...navigation("leaderboard", portalOrigin).components.filter((item) => item.custom_id !== "cog:leaderboard"),
      ),
    );
  } else {
    children.push(text("-# Official published results · shared from CogWorks"));
  }
  return componentMessage([surface(children, ACCENT_VERIFY)], {
    ephemeral: !shared,
    update: !shared && updateFor(interaction),
  });
}

async function localView(
  interaction: DiscordInteraction,
  portal: PortalRpcContract,
  guildId: string,
  user: DiscordUser,
  portalOrigin?: string,
): Promise<InteractionResponse> {
  const result = await portal.getLocalReports(guildId, user.id);
  if (!result.linked) return connectView(interaction, portal, guildId, user);
  const lines = result.reports.slice(0, 8).map((report) => {
    const primary = report.metrics.find((metric) => metric.primary);
    const state = report.dirty
      ? "dirty worktree"
      : report.sha
        ? `\`${report.sha.slice(0, 7)}\``
        : "no commit";
    return `• **${report.author.login}** · ${state}${primary ? ` · **${metricValue(primary)}**` : ""}`;
  });
  const body = lines.length
    ? lines.join("\n")
    : "No one on your team has synced a local report yet. That's okay—local practice stays local until someone chooses to share it.";
  return componentMessage(
    [
      surface(
        [
          text(`## Local field notes\n${body}\n\n-# Self-reported · useful for teammates · never leaderboard-eligible`),
          separator(),
          navigation("local", portalOrigin),
        ],
        ACCENT_INK,
      ),
    ],
    { update: updateFor(interaction) },
  );
}

function requestedView(interaction: DiscordInteraction): RequestedView {
  const customId = interaction.data?.custom_id;
  if (customId === "cog:share:leaderboard") return "share:leaderboard";
  if (customId === "cog:bind-channel") return "bind-channel";
  if (customId === "cog:bind-channel:confirm") return "bind-channel:confirm";
  if (customId?.startsWith("cog:")) {
    const view = customId.slice(4);
    if (VIEW_IDS.has(view as View)) return view as View;
  }

  const legacy = legacySubcommand(interaction)?.name;
  if (legacy === "status") return "home";
  if (legacy === "link") return "connect";
  if (legacy && VIEW_IDS.has(legacy as View)) return legacy as View;

  const option = stringOption(interaction.data?.options, "view");
  return option && VIEW_IDS.has(option as View) ? (option as View) : "home";
}

function bindChannelView(interaction: DiscordInteraction, confirm = false): InteractionResponse {
  if (!interaction.channel_id) return message("Open /cog inside the channel your team will use.");
  if (confirm) return message("Confirming the team channel…");
  return componentMessage(
    [
      surface(
        [
          text(
            [
              "## Make this the team bench?",
              "Cog will post one live bubble per explicitly shared local run here, then edit that same message as the run moves.",
              "",
              "Everyone who can read this channel can see the author, commit, progress, and self-reported score. Source code and raw outputs stay on the student's device.",
            ].join("\n"),
          ),
          separator(),
          actionRow(
            button("cog:bind-channel:confirm", "Yes, use this channel", 1),
            button("cog:home", "Not now", 2),
          ),
        ],
        ACCENT_DETECT,
      ),
    ],
    { update: updateFor(interaction) },
  );
}

export async function executeCommand(
  interaction: DiscordInteraction,
  portal: PortalRpcContract,
  configuredGuildId: string,
  portalOrigin?: string,
): Promise<InteractionResponse> {
  const guildId = interaction.guild_id;
  if (!guildId || guildId !== configuredGuildId) {
    return message("Cog lives in the CogWorks course server for now.");
  }
  const user = interactionUser(interaction);
  if (!user) return message("I couldn't tell who opened Cog. Close this and try once more.");

  switch (requestedView(interaction)) {
    case "home":
      return homeView(interaction, portal, guildId, user, portalOrigin);
    case "connect":
      return connectView(interaction, portal, guildId, user);
    case "benchmarks":
      return benchmarksView(interaction, portal, guildId, portalOrigin);
    case "leaderboard":
      return leaderboardView(interaction, portal, guildId, portalOrigin);
    case "share:leaderboard":
      return leaderboardView(interaction, portal, guildId, portalOrigin, true);
    case "bind-channel":
      return bindChannelView(interaction);
    case "bind-channel:confirm":
      if (!interaction.channel_id) return message("Open /cog inside the channel your team will use.");
      await portal.bindTeamChannel(guildId, user.id, interaction.channel_id);
      return homeView(interaction, portal, guildId, user, portalOrigin);
    case "local":
      return localView(interaction, portal, guildId, user, portalOrigin);
  }
}
