import {
  EPHEMERAL,
  IS_COMPONENTS_V2,
  surface,
  text,
  type DiscordContainer,
  type DiscordTextDisplay,
} from "@cogworks/discord-kit/components";
import { ACCENT_DETECT } from "@cogworks/discord-kit/accents";

/** Discord interaction protocol types; layout primitives live in discord-kit. */
export interface DiscordUser {
  id: string;
  username: string;
  global_name?: string | null;
}

export interface DiscordOption {
  name: string;
  type: number;
  value?: string | number | boolean;
  options?: DiscordOption[];
}

export interface DiscordInteraction {
  id: string;
  application_id?: string;
  token?: string;
  type: number;
  guild_id?: string;
  channel_id?: string;
  member?: { user: DiscordUser };
  user?: DiscordUser;
  data?: {
    /** Discord uses command type 4 for an Activity Entry Point. */
    type?: number;
    name?: string;
    options?: DiscordOption[];
    custom_id?: string;
    component_type?: number;
    values?: string[];
  };
}

export interface InteractionResponse {
  type: number;
  data?: {
    content?: string;
    flags?: number;
    components?: DiscordContainer[];
    allowed_mentions?: { parse: string[] };
  };
}

export const INTERACTION_APPLICATION_COMMAND = 2;
export const INTERACTION_MESSAGE_COMPONENT = 3;
export const RESPONSE_PONG = 1;
export const RESPONSE_CHANNEL_MESSAGE = 4;
export const RESPONSE_DEFERRED_CHANNEL_MESSAGE = 5;
export const RESPONSE_DEFERRED_UPDATE_MESSAGE = 6;
export const RESPONSE_UPDATE_MESSAGE = 7;
export const RESPONSE_LAUNCH_ACTIVITY = 12;

export { EPHEMERAL, IS_COMPONENTS_V2 };

/** Components V2 keeps Cog's layout native to Discord and consistent across clients. */
export function componentMessage(
  components: DiscordContainer[],
  options: { ephemeral?: boolean; update?: boolean } = {},
): InteractionResponse {
  const ephemeral = options.ephemeral ?? true;
  return {
    type: options.update ? RESPONSE_UPDATE_MESSAGE : RESPONSE_CHANNEL_MESSAGE,
    data: {
      flags: IS_COMPONENTS_V2 | (ephemeral ? EPHEMERAL : 0),
      components,
      allowed_mentions: { parse: [] },
    },
  };
}

export function message(content: string, ephemeral = true): InteractionResponse {
  return componentMessage([surface([text(content)], ACCENT_DETECT)], { ephemeral });
}

export function launchActivity(): InteractionResponse {
  return { type: RESPONSE_LAUNCH_ACTIVITY };
}

export function interactionUser(interaction: DiscordInteraction): DiscordUser | null {
  return interaction.member?.user ?? interaction.user ?? null;
}

export function stringOption(options: DiscordOption[] | undefined, name: string): string | undefined {
  const value = options?.find((item) => item.name === name)?.value;
  return typeof value === "string" ? value : undefined;
}

/** Supports the previous subcommand shape during command-registration rollout. */
export function legacySubcommand(interaction: DiscordInteraction): DiscordOption | null {
  return interaction.data?.options?.find((option) => option.type === 1) ?? null;
}

export function responseText(response: InteractionResponse): string {
  return (
    response.data?.components
      ?.flatMap((container) => container.components)
      .flatMap((component) =>
        component.type === 9 ? component.components : [component],
      )
      .filter((component): component is DiscordTextDisplay => component.type === 10)
      .map((component) => component.content)
      .join("\n") ??
    response.data?.content ??
    ""
  );
}
