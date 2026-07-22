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
