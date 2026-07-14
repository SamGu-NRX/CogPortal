import type { PortalRpcContract } from "@cogworks/contracts/discord";
import { executeCommand } from "./commands.ts";
import {
  RESPONSE_PONG,
  message,
  type DiscordInteraction,
} from "./interaction.ts";
import { verifyDiscordRequest } from "./verify.ts";

interface Env {
  DISCORD_PUBLIC_KEY: string;
  COURSE_GUILD_ID: string;
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
    if (interaction.type !== 2 || interaction.data?.name !== "cog") {
      return Response.json(message("Unsupported interaction.", true));
    }
    try {
      const response = await Promise.race([
        executeCommand(interaction, env.PORTAL, env.COURSE_GUILD_ID),
        new Promise<ReturnType<typeof message>>((resolve) =>
          setTimeout(
            () => resolve(message("CogPortal took too long to respond. Try again in a moment.", true)),
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
      return Response.json(message("CogPortal could not complete that request. Try again shortly.", true));
    }
  },
};
