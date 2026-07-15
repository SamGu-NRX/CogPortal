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
  channel_id?: string;
  member?: { user: DiscordUser };
  user?: DiscordUser;
  data?: {
    name?: string;
    options?: DiscordOption[];
    custom_id?: string;
    component_type?: number;
  };
}

export interface DiscordTextDisplay {
  type: 10;
  content: string;
}

export interface DiscordButton {
  type: 2;
  style: 1 | 2 | 3 | 4 | 5;
  label: string;
  custom_id?: string;
  url?: string;
  disabled?: boolean;
}

export interface DiscordActionRow {
  type: 1;
  components: DiscordButton[];
}

export interface DiscordSeparator {
  type: 14;
  divider?: boolean;
  spacing?: 1 | 2;
}

export type DiscordContainerChild = DiscordTextDisplay | DiscordActionRow | DiscordSeparator;

export interface DiscordContainer {
  type: 17;
  accent_color?: number;
  components: DiscordContainerChild[];
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
export const RESPONSE_UPDATE_MESSAGE = 7;
export const EPHEMERAL = 1 << 6;
export const IS_COMPONENTS_V2 = 1 << 15;

export const ACCENT_INK = 0x1c2637;
export const ACCENT_DETECT = 0xc63d2f;
export const ACCENT_VERIFY = 0x2e6b4f;

export function text(content: string): DiscordTextDisplay {
  return { type: 10, content: content.slice(0, 4_000) };
}

export function separator(divider = true): DiscordSeparator {
  return { type: 14, divider, spacing: 1 };
}

export function button(
  customId: string,
  label: string,
  style: 1 | 2 | 3 | 4 = 2,
  disabled = false,
): DiscordButton {
  return { type: 2, style, label, custom_id: customId, disabled: disabled || undefined };
}

export function linkButton(url: string, label: string): DiscordButton {
  return { type: 2, style: 5, label, url };
}

export function actionRow(...buttons: DiscordButton[]): DiscordActionRow {
  return { type: 1, components: buttons.slice(0, 5) };
}

export function surface(
  children: DiscordContainerChild[],
  accentColor = ACCENT_INK,
): DiscordContainer {
  return { type: 17, accent_color: accentColor, components: children };
}

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
      .filter((component): component is DiscordTextDisplay => component.type === 10)
      .map((component) => component.content)
      .join("\n") ??
    response.data?.content ??
    ""
  );
}
