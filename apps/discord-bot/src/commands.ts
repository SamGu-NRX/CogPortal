import type { PortalRpcContract } from "@cogworks/contracts/discord";
import type { Metric, RunSummary } from "@cogworks/contracts/schema";
import {
  message,
  stringOption,
  subcommand,
  interactionUser,
  type DiscordInteraction,
  type InteractionResponse,
} from "./interaction.ts";

function metricValue(metric: Metric): string {
  const value = metric.value.toFixed(metric.precision);
  return metric.unit ? `${value} ${metric.unit}` : value;
}

function runLine(label: string, run: RunSummary | null): string {
  if (!run) return `**${label}:** none`;
  const score = run.primaryMetric ? ` · ${metricValue(run.primaryMetric)}` : "";
  return `**${label}:** ${run.status} · \`${run.shortSha}\`${score}`;
}

export async function executeCommand(
  interaction: DiscordInteraction,
  portal: PortalRpcContract,
  configuredGuildId: string,
): Promise<InteractionResponse> {
  const guildId = interaction.guild_id;
  if (!guildId || guildId !== configuredGuildId) {
    return message("CogBot is currently available only in the course server.", true);
  }
  const user = interactionUser(interaction);
  const command = subcommand(interaction);
  if (!user || !command) return message("That command was incomplete. Try `/cog status`.", true);

  switch (command.name) {
    case "benchmarks": {
      const benchmarks = await portal.getBenchmarks(guildId);
      const lines = benchmarks.map(
        (benchmark) =>
          `${benchmark.active ? "●" : "○"} **${benchmark.title}** — ${benchmark.summary}`,
      );
      return message(lines.length ? lines.join("\n") : "No benchmarks are currently published.");
    }
    case "leaderboard": {
      const benchmarkId = stringOption(command, "benchmark");
      const leaderboard = await portal.getLeaderboard(guildId, benchmarkId);
      if (leaderboard.entries.length === 0) {
        return message(`**${leaderboard.benchmark.title}** has no published results yet.`);
      }
      const lines = leaderboard.entries.slice(0, 10).map(
        (entry) =>
          `${entry.rank}. **${entry.teamName}** — ${metricValue(entry.primaryMetric)} · \`${entry.shortSha}\``,
      );
      return message(`**${leaderboard.benchmark.title}**\n${lines.join("\n")}`);
    }
    case "status": {
      const status = await portal.getTeamStatus(guildId, user.id);
      if (!status.linked) return message("Link your account first with `/cog link`.", true);
      if (!status.team) {
        return message(
          `Linked to GitHub as **${status.githubLogin}**. Join a cohort and connect a repository in CogPortal to see team status.`,
          true,
        );
      }
      return message(
        [
          `**${status.team.name}** · ${status.team.repo?.fullName ?? "repository not connected"}`,
          runLine("Active", status.activeRun),
          runLine("Hosted verified", status.latestHosted),
          runLine("Official", status.latestOfficial),
        ].join("\n"),
        true,
      );
    }
    case "local": {
      const benchmarkId = stringOption(command, "benchmark");
      const result = await portal.getLocalReports(guildId, user.id, benchmarkId);
      if (!result.linked) return message("Link your account first with `/cog link`.", true);
      if (result.reports.length === 0) {
        return message("No team reports have been explicitly synced from CogBench.", true);
      }
      const lines = result.reports.slice(0, 8).map((report) => {
        const primary = report.metrics.find((metric) => metric.primary);
        const state = report.dirty ? "dirty worktree" : report.sha ? `\`${report.sha.slice(0, 7)}\`` : "no commit";
        return `• **${report.author.login}** · ${state}${primary ? ` · ${metricValue(primary)}` : ""}`;
      });
      return message(`**Local · self-reported**\n${lines.join("\n")}\nThese results are never leaderboard-eligible.`, true);
    }
    case "link": {
      const start = await portal.createDiscordLink(
        guildId,
        user.id,
        user.global_name ? `${user.global_name} (@${user.username})` : `@${user.username}`,
      );
      if (start.alreadyLinked) {
        return message("This Discord account is already linked. Use `/cog status` to check it.", true);
      }
      return message(
        `Open this private link to confirm with GitHub: ${start.url}\nThe link expires in 10 minutes and can be used once.`,
        true,
      );
    }
    case "unlink": {
      const result = await portal.unlinkDiscord(guildId, user.id);
      return message(result.unlinked ? "Discord has been unlinked from CogPortal." : "This Discord account was not linked.", true);
    }
    default:
      return message("Unknown subcommand. Try `/cog status`.", true);
  }
}
