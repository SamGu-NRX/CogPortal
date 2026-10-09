// Registers CogBot's commands with the real Discord API. It needs
// DISCORD_APPLICATION_ID, DISCORD_BOT_TOKEN, and COURSE_GUILD_ID in the
// environment and fails fast with a clear message when any of them is
// missing.
//
// The sequence: first GET the application's global commands and find the
// existing type-4 Entry Point, then PATCH it in place, or POST to create it
// when there isn't one yet; that part is global, not guild-scoped. Then PUT
// the guild command set for COURSE_GUILD_ID. That PUT replaces the whole
// guild command list with just /cog, so any other command registered on the
// guild is removed.
//
// Rerunning is idempotent: the Entry Point gets patched rather than
// duplicated, and the guild PUT lands on the same set every time. HTTP
// failures raise with the status and the first 500 characters of the
// Discord error body.
//
// Run it with `pnpm --filter @cogworks/discord-bot commands:register`, with
// the bot token handled as a secret. It needs real network access and real
// credentials, so it never runs in CI.
//
// The payloads come from command-payloads.mjs, the same module the Worker
// tests import, so the registered commands and the Worker's behavior share
// one source of truth.

import { cogCommand, entryPointCommand } from "./command-payloads.mjs";

const { DISCORD_APPLICATION_ID, DISCORD_BOT_TOKEN, COURSE_GUILD_ID } = process.env;
if (!DISCORD_APPLICATION_ID || !DISCORD_BOT_TOKEN || !COURSE_GUILD_ID) {
  throw new Error("Set DISCORD_APPLICATION_ID, DISCORD_BOT_TOKEN, and COURSE_GUILD_ID.");
}

const headers = {
  Authorization: `Bot ${DISCORD_BOT_TOKEN}`,
  "Content-Type": "application/json",
};

const globalCommandsUrl = `https://discord.com/api/v10/applications/${DISCORD_APPLICATION_ID}/commands`;
const globalResponse = await fetch(globalCommandsUrl, { headers });
if (!globalResponse.ok) {
  const detail = (await globalResponse.text()).slice(0, 500);
  throw new Error(`Discord global-command lookup failed (${globalResponse.status}): ${detail}`);
}
const globalCommands = await globalResponse.json();
const currentEntryPoint = Array.isArray(globalCommands)
  ? globalCommands.find((item) => item?.type === 4)
  : null;
const entryPointResponse = await fetch(
  currentEntryPoint?.id ? `${globalCommandsUrl}/${currentEntryPoint.id}` : globalCommandsUrl,
  {
    method: currentEntryPoint?.id ? "PATCH" : "POST",
    headers,
    body: JSON.stringify(entryPointCommand),
  },
);
if (!entryPointResponse.ok) {
  const detail = (await entryPointResponse.text()).slice(0, 500);
  throw new Error(
    `Discord Entry Point registration failed (${entryPointResponse.status}): ${detail}`,
  );
}

const response = await fetch(
  `https://discord.com/api/v10/applications/${DISCORD_APPLICATION_ID}/guilds/${COURSE_GUILD_ID}/commands`,
  {
    method: "PUT",
    headers,
    body: JSON.stringify([cogCommand]),
  },
);
if (!response.ok) {
  const detail = (await response.text()).slice(0, 500);
  throw new Error(`Discord command registration failed (${response.status}): ${detail}`);
}
console.log("Registered the app-handled Activity Entry Point and /cog home surface.");
