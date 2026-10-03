import { portalRefusal } from "@cogworks/contracts/discord";
import { ACCENT_DETECT } from "@cogworks/discord-kit/accents";
import { actionRow, button, linkButton, separator, surface, text, type DiscordButton } from "@cogworks/discord-kit/components";
import { plainText } from "@cogworks/discord-kit/format";
import { safePortalUrl } from "./commands.ts";
import { componentMessage, type DiscordInteraction, type InteractionResponse } from "./interaction.ts";

/**
 * What a student sees when a command throws instead of answering.
 *
 * Three cases, and they promise different things:
 *
 * - The portal refused. Its sentence was written for the student and says
 *   what to do, so it is shown as written. The Activity and the web portal
 *   show the same sentence for the same refusal.
 * - Anything else during a confirmed change. The bot cannot tell a request
 *   that never arrived from one whose answer was lost, so it says the change
 *   may have happened and points at where to look.
 * - Anything else while only reading. Nothing could have changed, so it says
 *   to try again.
 *
 * Each ends with a way back, because a deferred update replaces the panel the
 * student pressed and an answer with no buttons is a dead end.
 */
export function failureResponse(
  interaction: DiscordInteraction,
  error: unknown,
  portalOrigin?: string,
): InteractionResponse {
  const customId = interaction.data?.custom_id ?? "";
  const surfaceId = /^cog:surface:([^:]+):/.exec(customId)?.[1];
  const portalUrl = safePortalUrl(portalOrigin, surfaceId ? `/run-surfaces/${encodeURIComponent(surfaceId)}` : "/dashboard");
  const refusal = portalRefusal(error);
  const changing = customId.endsWith(":confirm");

  const body = refusal
    ? plainText(refusal.message)
    : changing
      ? surfaceId
        ? "I couldn't confirm that with Cog\\*Portal. It may still have gone through, so check the run there before pressing it again."
        : "I couldn't confirm that with Cog\\*Portal. It may still have gone through, so check the team bench before trying again."
      : "I couldn't reach Cog\\*Portal just now. Try again in a moment.";

  const actions: DiscordButton[] = [button("cog:home", "Back to Cog", 2)];
  if (portalUrl && (refusal || surfaceId)) actions.push(linkButton(portalUrl, "Open Cog*Portal"));

  return componentMessage([surface([text(body), separator(), actionRow(...actions)], ACCENT_DETECT)]);
}
