const { DISCORD_APPLICATION_ID, DISCORD_BOT_TOKEN, COURSE_GUILD_ID } = process.env;
if (!DISCORD_APPLICATION_ID || !DISCORD_BOT_TOKEN || !COURSE_GUILD_ID) {
  throw new Error("Set DISCORD_APPLICATION_ID, DISCORD_BOT_TOKEN, and COURSE_GUILD_ID.");
}

const benchmarkOption = {
  type: 3,
  name: "benchmark",
  description: "Optional benchmark ID",
  required: false,
};

const command = {
  name: "cog",
  description: "CogWorks benchmark status",
  options: [
    { type: 1, name: "benchmarks", description: "List available benchmarks" },
    { type: 1, name: "leaderboard", description: "Show published results", options: [benchmarkOption] },
    { type: 1, name: "status", description: "Show your team benchmark status" },
    { type: 1, name: "local", description: "Show explicitly synced local reports", options: [benchmarkOption] },
    { type: 1, name: "link", description: "Link Discord to your CogPortal account" },
    { type: 1, name: "unlink", description: "Unlink Discord from CogPortal" },
  ],
};

const response = await fetch(
  `https://discord.com/api/v10/applications/${DISCORD_APPLICATION_ID}/guilds/${COURSE_GUILD_ID}/commands`,
  {
    method: "POST",
    headers: {
      Authorization: `Bot ${DISCORD_BOT_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(command),
  },
);
if (!response.ok) throw new Error(`Discord command registration failed (${response.status}).`);
console.log("Registered /cog in the configured course guild.");
