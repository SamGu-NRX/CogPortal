import type { PortalRpcContract } from "@cogworks/contracts/discord";
import { executeCommand } from "./commands.ts";
import {
  INTERACTION_APPLICATION_COMMAND,
  INTERACTION_MESSAGE_COMPONENT,
  RESPONSE_PONG,
  message,
  type DiscordInteraction,
} from "./interaction.ts";
import { verifyDiscordRequest } from "./verify.ts";

interface Env {
  DISCORD_PUBLIC_KEY: string;
  COURSE_GUILD_ID: string;
  PORTAL_ORIGIN?: string;
  PORTAL: PortalRpcContract;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method !== "POST") return new Response("Not found", { status: 404 });
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
    const isCogCommand =
      interaction.type === INTERACTION_APPLICATION_COMMAND && interaction.data?.name === "cog";
    const isCogComponent =
      interaction.type === INTERACTION_MESSAGE_COMPONENT &&
      interaction.data?.custom_id?.startsWith("cog:");
    if (!isCogCommand && !isCogComponent) {
      return Response.json(message("Unsupported interaction.", true));
    }
    try {
      const response = await Promise.race([
        executeCommand(interaction, env.PORTAL, env.COURSE_GUILD_ID, env.PORTAL_ORIGIN),
        new Promise<ReturnType<typeof message>>((resolve) =>
          setTimeout(
            () => resolve(message("CogPortal is taking a breather. Nothing changed—try again in a moment.", true)),
            2_500,
          ),
        ),
      ]);
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
        message("I couldn't reach CogPortal just now. Nothing changed—try again in a moment.", true),
      );
    }
  },
};
