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
  type: number;
  guild_id?: string;
  member?: { user: DiscordUser };
  user?: DiscordUser;
  data?: {
    name: string;
    options?: DiscordOption[];
  };
}

export interface InteractionResponse {
  type: number;
  data?: {
    content: string;
    flags?: number;
    allowed_mentions?: { parse: string[] };
  };
}

export const RESPONSE_CHANNEL_MESSAGE = 4;
export const RESPONSE_PONG = 1;
export const EPHEMERAL = 1 << 6;

export function message(content: string, ephemeral = false): InteractionResponse {
  return {
    type: RESPONSE_CHANNEL_MESSAGE,
    data: {
      content: content.slice(0, 2_000),
      flags: ephemeral ? EPHEMERAL : undefined,
      allowed_mentions: { parse: [] },
    },
  };
}

export function interactionUser(interaction: DiscordInteraction): DiscordUser | null {
  return interaction.member?.user ?? interaction.user ?? null;
}

export function subcommand(interaction: DiscordInteraction): DiscordOption | null {
  return interaction.data?.options?.find((option) => option.type === 1) ?? null;
}

export function stringOption(option: DiscordOption | null, name: string): string | undefined {
  const value = option?.options?.find((item) => item.name === name)?.value;
  return typeof value === "string" ? value : undefined;
}
