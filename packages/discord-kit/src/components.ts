/**
 * Typed Components V2 layout primitives shared by CogBot (ephemeral /cog surfaces)
 * and Cog*Portal (the public live run message). One kit, one vocabulary: if a
 * component shape changes here, every Discord surface changes together.
 */

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

export interface DiscordThumbnail {
  type: 11;
  media: { url: string };
  description?: string;
  spoiler?: boolean;
}

/** A section pairs one to three text displays with a single right-side accessory. */
export interface DiscordSection {
  type: 9;
  components: DiscordTextDisplay[];
  accessory: DiscordButton | DiscordThumbnail;
}

export type DiscordContainerChild =
  | DiscordTextDisplay
  | DiscordActionRow
  | DiscordSeparator
  | DiscordSection;

export interface DiscordContainer {
  type: 17;
  accent_color?: number;
  components: DiscordContainerChild[];
}

export const EPHEMERAL = 1 << 6;
export const IS_COMPONENTS_V2 = 1 << 15;

/** Discord rejects any single text display beyond 4,000 characters. */
export function text(content: string): DiscordTextDisplay {
  return { type: 10, content: content.slice(0, 4_000) };
}

export function separator(divider = true, spacing: 1 | 2 = 1): DiscordSeparator {
  return { type: 14, divider, spacing };
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

export function thumbnail(url: string, description?: string): DiscordThumbnail {
  return { type: 11, media: { url }, description };
}

/**
 * Accessory buttons deliver their custom_id exactly like row buttons, so a
 * section is the way to attach one quiet control without spending a full row.
 */
export function section(
  content: DiscordTextDisplay | DiscordTextDisplay[],
  accessory: DiscordButton | DiscordThumbnail,
): DiscordSection {
  const components = Array.isArray(content) ? content.slice(0, 3) : [content];
  return { type: 9, components, accessory };
}

export function surface(
  children: DiscordContainerChild[],
  accentColor?: number,
): DiscordContainer {
  return { type: 17, accent_color: accentColor, components: children };
}
