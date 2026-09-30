import { executeCommand } from "./commands.ts";
import {
  INTERACTION_APPLICATION_COMMAND,
  INTERACTION_MESSAGE_COMPONENT,
  EPHEMERAL,
  RESPONSE_DEFERRED_CHANNEL_MESSAGE,
  RESPONSE_DEFERRED_UPDATE_MESSAGE,
  RESPONSE_PONG,
  launchActivity,
  message,
  type DiscordInteraction,
} from "./interaction.ts";
import { verifyDiscordRequest } from "./verify.ts";
import { validateBotEnv } from "./env.ts";
import type { Env } from "./env.ts";

async function editDeferredResponse(
  interaction: DiscordInteraction,
  env: Env,
): Promise<void> {
  if (!interaction.application_id || !interaction.token) {
    console.error(
      JSON.stringify({
        event: "discord_deferred_response_missing_token",
        interactionId: interaction.id,
      }),
    );
    return;
  }
  let response;
  try {
    response = await executeCommand(
      interaction,
      env.PORTAL,
      env.COURSE_GUILD_ID,
      env.PORTAL_ORIGIN,
    );
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "discord_command_failed",
        interactionId: interaction.id,
        message: error instanceof Error ? error.message : "unknown",
      }),
    );
    response = message("I couldn't reach Cog*Portal just now. Nothing changed. Try again in a moment.", true);
  }
  const patched = await fetch(
    `https://discord.com/api/v10/webhooks/${encodeURIComponent(interaction.application_id)}/${encodeURIComponent(interaction.token)}/messages/@original`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(response.data ?? {}),
    },
  );
  if (!patched.ok) {
    console.error(
      JSON.stringify({
        event: "discord_deferred_response_edit_failed",
        interactionId: interaction.id,
        status: patched.status,
      }),
    );
  }
}

export default {
  async fetch(request: Request, env: Env, context: ExecutionContext): Promise<Response> {
    if (request.method !== "POST") return new Response("Not found", { status: 404 });
    validateBotEnv(env);
    const body = await request.arrayBuffer();
    const valid = await verifyDiscordRequest(
      env.DISCORD_PUBLIC_KEY,
      request.headers.get("X-Signature-Ed25519"),
      request.headers.get("X-Signature-Timestamp"),
      body,
    );
    if (!valid) return new Response("Invalid request signature", { status: 401 });

    let interaction: DiscordInteraction;
    try {
      interaction = JSON.parse(new TextDecoder().decode(body)) as DiscordInteraction;
    } catch {
      return Response.json(message("Discord sent an invalid interaction.", true), { status: 400 });
    }
    if (interaction.type === 1) return Response.json({ type: RESPONSE_PONG });
    const isActivityEntryPoint =
      interaction.type === INTERACTION_APPLICATION_COMMAND && interaction.data?.type === 4;
    const isCogCommand =
      interaction.type === INTERACTION_APPLICATION_COMMAND && interaction.data?.name === "cog";
    const isCogComponent =
      interaction.type === INTERACTION_MESSAGE_COMPONENT &&
      interaction.data?.custom_id?.startsWith("cog:");
    if (!isCogCommand && !isCogComponent && !isActivityEntryPoint) {
      return Response.json(message("Unsupported interaction.", true));
    }
    if (isActivityEntryPoint) {
      if (interaction.guild_id !== env.COURSE_GUILD_ID) {
        return Response.json(message("Cog is only enabled inside the CogWorks course server.", true));
      }
      return Response.json(launchActivity());
    }
    const customId = interaction.data?.custom_id;
    if (customId?.startsWith("cog:surface:") && customId.endsWith(":open_console")) {
      if (interaction.guild_id !== env.COURSE_GUILD_ID) {
        return Response.json(message("Cog is only enabled inside the CogWorks course server.", true));
      }
      return Response.json(launchActivity());
    }
    const isPublicShare = interaction.data?.custom_id === "cog:share:leaderboard";
    if (!isPublicShare) {
      context.waitUntil(editDeferredResponse(interaction, env));
      const surfaceAction = customId?.startsWith("cog:surface:");
      const surfaceConfirmation = surfaceAction && customId?.endsWith(":confirm");
      return Response.json(
        interaction.type === INTERACTION_MESSAGE_COMPONENT && (!surfaceAction || surfaceConfirmation)
          ? { type: RESPONSE_DEFERRED_UPDATE_MESSAGE }
          : { type: RESPONSE_DEFERRED_CHANNEL_MESSAGE, data: { flags: EPHEMERAL } },
      );
    }
    try {
      const response = await executeCommand(
        interaction,
        env.PORTAL,
        env.COURSE_GUILD_ID,
        env.PORTAL_ORIGIN,
      );
      return Response.json(response);
    } catch (error) {
      console.error(
        JSON.stringify({
          event: "discord_command_failed",
          interactionId: interaction.id,
          message: error instanceof Error ? error.message : "unknown",
        }),
      );
      return Response.json(
        message("I couldn't reach Cog*Portal just now. Nothing changed. Try again in a moment.", true),
      );
    }
  },
};
