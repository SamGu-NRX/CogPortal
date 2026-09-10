import type { PortalRpcContract } from "@cogworks/contracts/discord";
import type { RunSurfaceAction, RunSurfaceSnapshot } from "@cogworks/contracts/schema";
import { ACCENT_DETECT, ACCENT_INK, ACCENT_VERIFY } from "@cogworks/discord-kit/accents";
import {
  actionRow,
  button,
  linkButton,
  selectRow,
  separator,
  surface,
  text,
  type DiscordButton,
  type DiscordContainerChild,
  type DiscordSelectOption,
} from "@cogworks/discord-kit/components";
import {
  emojiFormatter,
  emojiObject,
  quotaCells,
  rankMark,
  type EmojiFormatter,
  type EmojiName,
} from "@cogworks/discord-kit/emoji";
import { META_SEP, chip, metaLine, metricValue } from "@cogworks/discord-kit/format";
import {
  INTERACTION_MESSAGE_COMPONENT,
  componentMessage,
  interactionUser,
  legacySubcommand,
  message,
  stringOption,
  type DiscordInteraction,
  type DiscordUser,
  type InteractionResponse,
} from "./interaction.ts";

type View = "home" | "leaderboard" | "benchmarks" | "local" | "connect";
type RequestedView = View | "share:leaderboard" | "bind-channel" | "bind-channel:confirm";

type SurfaceMutation = "verify_hosted" | "promote_official" | "publish_result" | "rerun_hosted";

const VIEW_IDS = new Set<View>(["home", "leaderboard", "benchmarks", "local", "connect"]);

function safePortalUrl(origin: string | undefined, path: string): string | null {
  if (!origin) return null;
  try {
    const url = new URL(path, origin);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch {
    return null;
  }
}

const NAV_ITEMS: { view: View; label: string; description: string; glyph: EmojiName }[] = [
  { view: "home", label: "Team bench", description: "Your team, latest run, and next action", glyph: "cog_flask" },
  { view: "leaderboard", label: "Leaderboard", description: "Official published results", glyph: "cog_board" },
  { view: "benchmarks", label: "Benchmarks", description: "What's on the bench right now", glyph: "cog_vision" },
  { view: "local", label: "Local notes", description: "Self-reported team practice", glyph: "cog_notes" },
];

function navigation(
  active: View,
  interaction: DiscordInteraction,
  portalOrigin?: string,
  options: { portalLink?: boolean } = {},
): DiscordContainerChild[] {
  const appId = interaction.application_id;
  const selectOptions: DiscordSelectOption[] = NAV_ITEMS.map((item) => ({
    label: item.label,
    value: item.view,
    description: item.description,
    emoji: emojiObject(item.glyph, appId),
    default: item.view === active,
  }));
  const children: DiscordContainerChild[] = [selectRow("cog:nav", selectOptions, "Go to…")];
  const portalUrl = safePortalUrl(portalOrigin, "/dashboard");
  if ((options.portalLink ?? true) && portalUrl) {
    children.push(actionRow(linkButton(portalUrl, "Cog*Portal")));
  }
  return children;
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
      ? actionRow(linkButton(portalUrl, "Choose your repository"), button("cog:home", "Refresh", 2))
      : actionRow(button("cog:home", "Refresh", 1));
    return componentMessage(
      [
        surface(
          [
            text(
              `### One small step left\nYou're linked as **${status.githubLogin}**. Choose your team's repository in Cog*Portal, then come back and refresh.`,
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

  const latestSurface = await portal.getRunSurface(guildId, user.id);

  const channelLine = status.discordChannelId
    ? `Live runs → <#${status.discordChannelId}>`
    : status.canManageDiscordChannel
      ? "Live runs are ready; choose this team's Discord channel below."
      : "Live runs are ready once a team creator or maintainer chooses the team channel.";
  const channelAction =
    !status.discordChannelId && status.canManageDiscordChannel && interaction.channel_id
      ? [separator(), actionRow(button("cog:bind-channel", "Use this as our team channel", 1))]
      : [];
  const priority: RunSurfaceAction[] = [
    "publish_result",
    "promote_official",
    "verify_hosted",
    "open_console",
    "run_again",
    "rerun_hosted",
  ];
  const nextAction = latestSurface
    ? priority.find((action) => latestSurface.actions.includes(action))
    : undefined;
  const nextButton = nextAction && latestSurface
    ? button(
        `cog:surface:${latestSurface.id}:${nextAction}`,
        {
          publish_result: "Publish result",
          promote_official: "Promote to official",
          verify_hosted: "Verify hosted",
          open_console: "Open live console",
          run_again: "Run again",
          rerun_hosted: "Rerun hosted",
          open_portal: "Open Cog*Portal",
        }[nextAction],
        nextAction === "publish_result" || nextAction === "promote_official" ? 1 : 2,
      )
    : null;
  const portalUrl = safePortalUrl(
    portalOrigin,
    latestSurface ? `/run-surfaces/${latestSurface.id}` : "/dashboard",
  );
  const primaryActions = [
    nextButton,
    portalUrl ? linkButton(portalUrl, "Open Cog*Portal") : null,
  ].filter((item): item is DiscordButton => item !== null);

  const fmt = emojiFormatter(interaction.application_id);
  const latestLine = latestSurface
    ? metaLine([
        `${fmt(surfaceMark(latestSurface.status))} **${latestSurface.benchmark.title}**`,
        latestSurface.stage,
        latestSurface.primaryMetric ? `**${metricValue(latestSurface.primaryMetric)}**` : null,
      ])
    : `${fmt("cog_flask")} The bench is ready. No shared runs yet.`;
  // Custom emoji stay on full-size lines; they render oversized inside `-#`.
  const attempts =
    latestSurface?.nextOfficialAttempt != null
      ? metaLine([
          quotaCells(latestSurface.nextOfficialAttempt - 1, 3, fmt),
          `official attempts   ${latestSurface.nextOfficialAttempt - 1} of 3 used`,
        ])
      : null;
  const repoLine = status.team.repo
    ? `${fmt("cog_repo")} ${chip(status.team.repo.fullName)}`
    : "-# repository not connected yet";

  return componentMessage(
    [
      surface(
        [
          text(
            [
              `### ${fmt("cog_flask")} ${status.team.name}`,
              repoLine,
              "",
              latestLine,
              attempts,
              "",
              channelLine,
              "",
              "-# private to you, quiet by default",
            ].filter((line): line is string => line !== null).join("\n"),
          ),
          ...channelAction,
          ...(primaryActions.length ? [separator(), actionRow(...primaryActions)] : []),
          separator(false),
          ...navigation("home", interaction, portalOrigin, { portalLink: false }),
        ],
        ACCENT_VERIFY,
      ),
    ],
    { update: updateFor(interaction) },
  );
}

function surfaceMark(status: RunSurfaceSnapshot["status"]): EmojiName {
  if (status === "succeeded") return "cog_done";
  if (status === "failed" || status === "cancelled") return "cog_fail";
  return "cog_active";
}

async function connectView(
  interaction: DiscordInteraction,
  portal: PortalRpcContract,
  guildId: string,
  user: DiscordUser,
): Promise<InteractionResponse> {
  const start = await portal.createDiscordLink(guildId, user.id, discordIdentity(user));
  if (start.alreadyLinked) return homeView(interaction, portal, guildId, user);
  if (!start.url) return message("I couldn't make a connection link just now. Nothing changed. Try again in a moment.");

  return componentMessage(
    [
      surface(
        [
          text(
            [
              `### ${emojiFormatter(interaction.application_id)("cog_link")} Hi ${displayName(user)}, I'm Cog`,
              "Your team's runs and results live in Cog*Portal. Linking lets me bring them into Discord, so you can follow a run or check the board without leaving chat.",
              "",
              "You'll confirm what Discord can see before anything connects. The link works once and expires in **10 minutes**.",
              "",
              "-# Cog never runs code on your laptop, and official actions always ask first.",
            ].join("\n"),
          ),
          separator(),
          actionRow(linkButton(start.url, "Link to Cog*Portal")),
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
  selectedId?: string,
): Promise<InteractionResponse> {
  const benchmarks = await portal.getBenchmarks(guildId);
  const fmt = emojiFormatter(interaction.application_id);
  const appId = interaction.application_id;
  const selected = benchmarks.find((benchmark) => benchmark.id === selectedId && benchmark.active);
  const lines = benchmarks.map((benchmark) => {
    const row = [
      `${fmt("cog_vision")} **${benchmark.title}**${benchmark.active ? "" : "   paused"}`,
      `-# ${benchmark.summary}`,
    ];
    if (selected?.id === benchmark.id) {
      const safeId = benchmark.id.replace(/[^a-zA-Z0-9._-]/g, "");
      row.push(
        `\`\`\`\ncogworks run --benchmark ${safeId} --live\n\`\`\``,
        "-# the run happens on your machine, and --live shares its progress with the team",
      );
    }
    return row.join("\n");
  });
  const active = benchmarks.filter((benchmark) => benchmark.active);
  const children: DiscordContainerChild[] = [
    text(
      `### ${fmt("cog_vision")} Benchmarks\n-# each one runs from your machine; choose it below to get the exact command\n\n${lines.length ? lines.join("\n\n") : "Nothing is published yet. The bench is getting set up."}`,
    ),
  ];
  if (active.length) {
    children.push(
      separator(false),
      selectRow(
        "cog:bench",
        active.map((benchmark) => ({
          label: benchmark.title,
          value: benchmark.id,
          description: "Show the terminal command",
          emoji: emojiObject("cog_vision", appId),
          default: benchmark.id === selected?.id,
        })),
        "Get the run command…",
      ),
    );
  }
  children.push(separator(), ...navigation("benchmarks", interaction, portalOrigin));
  return componentMessage([surface(children, ACCENT_INK)], { update: updateFor(interaction) });
}

async function leaderboardView(
  interaction: DiscordInteraction,
  portal: PortalRpcContract,
  guildId: string,
  portalOrigin?: string,
  shared = false,
): Promise<InteractionResponse> {
  const leaderboard = await portal.getLeaderboard(guildId);
  const fmt = emojiFormatter(interaction.application_id);
  const lines = leaderboard.entries.slice(0, 10).map((entry) => {
    const name = entry.isYou ? `**${entry.teamName}**` : entry.teamName;
    return metaLine([`${rankMark(entry.rank, fmt)} ${name}`, `**${metricValue(entry.primaryMetric)}**`]);
  });
  const body = lines.length
    ? lines.join("\n")
    : "The board is wide open. Your team could set the first mark.";
  const children: DiscordContainerChild[] = [
    text(`### ${fmt("cog_board")} ${leaderboard.benchmark.title} leaderboard\n${body}`),
  ];
  if (!shared) {
    children.push(
      separator(),
      actionRow(button("cog:share:leaderboard", "Share in channel", 1)),
      separator(false),
      ...navigation("leaderboard", interaction, portalOrigin),
    );
  } else {
    children.push(text("-# official published results, shared from CogWorks"));
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
  const fmt = emojiFormatter(interaction.application_id);
  const lines = result.reports.slice(0, 8).map((report) => {
    const primary = report.metrics.find((metric) => metric.primary);
    const state = report.dirty
      ? "dirty worktree"
      : report.sha
        ? chip(report.sha.slice(0, 7))
        : "no commit";
    return metaLine([
      `${fmt(report.dirty ? "cog_active" : "cog_done")} **${report.author.login}**`,
      state,
      primary ? `**${metricValue(primary)}**` : null,
    ]);
  });
  const body = lines.length
    ? lines.join("\n")
    : "No local reports yet. Local practice stays private until someone chooses to share it.";
  return componentMessage(
    [
      surface(
        [
          text(`### ${fmt("cog_notes")} Local field notes\n${body}\n\n-# self-reported, never leaderboard-eligible`),
          separator(),
          ...navigation("local", interaction, portalOrigin),
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
  if (customId === "cog:nav") {
    const chosen = interaction.data?.values?.[0];
    if (chosen && VIEW_IDS.has(chosen as View)) return chosen as View;
    return "home";
  }
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

function bindChannelView(interaction: DiscordInteraction): InteractionResponse {
  if (!interaction.channel_id) return message("Open /cog inside the channel your team will use.");
  return componentMessage(
    [
      surface(
        [
          text(
            [
              "### Make this the team bench?",
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

function surfaceAction(interaction: DiscordInteraction): {
  surfaceId: string;
  action: string;
  confirmed: boolean;
} | null {
  const parts = interaction.data?.custom_id?.split(":") ?? [];
  if (parts.length < 4 || parts[0] !== "cog" || parts[1] !== "surface") return null;
  return {
    surfaceId: parts[2] ?? "",
    action: parts[3] ?? "",
    confirmed: parts[4] === "confirm",
  };
}

function receipt(snapshot: RunSurfaceSnapshot, fmt: EmojiFormatter, extra: string[] = []): string {
  const lines = [
    metaLine([
      `${fmt("cog_vision")} **${snapshot.benchmark.title}**`,
      `${fmt("cog_repo")} ${chip(snapshot.shortSha)}`,
      snapshot.stage,
      snapshot.primaryMetric ? `**${metricValue(snapshot.primaryMetric)}**` : null,
    ]),
    ...extra,
  ];
  return lines.map((line) => `> ${line}`).join("\n");
}

async function surfaceActionView(
  interaction: DiscordInteraction,
  portal: PortalRpcContract,
  guildId: string,
  user: DiscordUser,
  portalOrigin?: string,
): Promise<InteractionResponse | null> {
  const request = surfaceAction(interaction);
  if (!request) return null;
  const snapshot = await portal.getRunSurface(guildId, user.id, request.surfaceId);
  if (!snapshot) return message("That run surface is no longer available.");
  const fmt = emojiFormatter(interaction.application_id);
  if (request.action === "run_again") {
    const result = await portal.getRerunCommand(guildId, user.id, request.surfaceId);
    return componentMessage(
      [
        surface(
          [
            text(
              `### Run it again\n${receipt(snapshot, fmt)}\n\nA fresh run gets its own message, so this one stays as history.\n\`\`\`\n${result.command}\n\`\`\``,
            ),
            separator(),
            actionRow(button("cog:home", "Back to Cog", 2)),
          ],
          ACCENT_INK,
        ),
      ],
      { update: request.confirmed },
    );
  }

  const mutations = new Set<SurfaceMutation>([
    "verify_hosted",
    "promote_official",
    "publish_result",
    "rerun_hosted",
  ]);
  if (!mutations.has(request.action as SurfaceMutation)) return message("That run action is not available.");
  const action = request.action as SurfaceMutation;
  if (!request.confirmed) {
    const attempt = snapshot.nextOfficialAttempt;
    const copy: Record<
      SurfaceMutation,
      { title: string; detail: string; label: string; style: 1 | 4; extra?: string[] }
    > = {
      verify_hosted: {
        title: "Verify this exact commit?",
        detail: "A hosted run scores this exact commit on the course machines and records what it sees. It's practice, and it uses one of this benchmark's hosted practice runs.",
        label: `Verify ${snapshot.shortSha} hosted`,
        style: 1,
      },
      promote_official: {
        title: "Use an official attempt?",
        detail: "This scores the same commit on the hidden set and spends one official attempt. It reuses the environment this run already built, so nothing reinstalls.",
        label: attempt ? `Use attempt ${attempt} of 3` : "Use an official attempt",
        style: 4,
        extra: attempt
          ? [`${quotaCells(attempt - 1, 3, fmt)}${META_SEP}attempt ${attempt} of 3`]
          : undefined,
      },
      publish_result: {
        title: "Publish this result?",
        detail: "This becomes the team's public leaderboard entry. You can replace it later with another official result.",
        label: "Publish to leaderboard",
        style: 4,
      },
      rerun_hosted: {
        title: "Start a new hosted run?",
        detail: "This starts a fresh hosted run on the same commit. The current run stays as history.",
        label: "Start hosted run",
        style: 1,
      },
    };
    const prompt = copy[action];
    return componentMessage([
      surface(
        [
          text(`### ${prompt.title}\n${receipt(snapshot, fmt, prompt.extra)}\n\n${prompt.detail}`),
          separator(),
          actionRow(
            button(`cog:surface:${snapshot.id}:${action}:confirm`, prompt.label, prompt.style),
            button("cog:home", "Not now", 2),
          ),
        ],
        ACCENT_DETECT,
      ),
    ]);
  }

  const updated =
    action === "verify_hosted"
      ? await portal.verifyHosted(guildId, user.id, snapshot.id)
      : action === "promote_official"
        ? await portal.promoteOfficial(guildId, user.id, snapshot.id)
        : action === "publish_result"
          ? await portal.publishResult(guildId, user.id, snapshot.id)
          : await portal.rerunHosted(guildId, user.id, snapshot.id);
  const portalUrl = safePortalUrl(portalOrigin, `/run-surfaces/${updated.id}`);
  return componentMessage(
    [
      surface(
        [
          text(`### Bench updated\n${receipt(updated, fmt)}\n-# the team message and live console follow this run from here`),
          ...(portalUrl ? [separator(), actionRow(linkButton(portalUrl, "Open Cog*Portal"))] : []),
        ],
        ACCENT_VERIFY,
      ),
    ],
    { update: true },
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

  const surfaceResponse = await surfaceActionView(
    interaction,
    portal,
    guildId,
    user,
    portalOrigin,
  );
  if (surfaceResponse) return surfaceResponse;

  if (interaction.data?.custom_id === "cog:bench") {
    return benchmarksView(interaction, portal, guildId, portalOrigin, interaction.data?.values?.[0]);
  }

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
