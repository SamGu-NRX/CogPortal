const { DISCORD_APPLICATION_ID, DISCORD_BOT_TOKEN, COURSE_GUILD_ID } = process.env;
if (!DISCORD_APPLICATION_ID || !DISCORD_BOT_TOKEN || !COURSE_GUILD_ID) {
  throw new Error("Set DISCORD_APPLICATION_ID, DISCORD_BOT_TOKEN, and COURSE_GUILD_ID.");
}

const command = {
  type: 1,
  name: "cog",
  description: "Open your CogWorks lab bench",
  options: [
    {
      type: 3,
      name: "view",
      description: "Go straight to a view (optional)",
      required: false,
      choices: [
        { name: "My team", value: "home" },
        { name: "Leaderboard", value: "leaderboard" },
        { name: "Benchmarks", value: "benchmarks" },
        { name: "Local practice", value: "local" },
        { name: "Connect account", value: "connect" },
      ],
    },
  ],
};

const response = await fetch(
  `https://discord.com/api/v10/applications/${DISCORD_APPLICATION_ID}/guilds/${COURSE_GUILD_ID}/commands`,
  {
    method: "PUT",
    headers: {
      Authorization: `Bot ${DISCORD_BOT_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify([command]),
  },
);
if (!response.ok) {
  const detail = (await response.text()).slice(0, 500);
  throw new Error(`Discord command registration failed (${response.status}): ${detail}`);
}
console.log("Registered the /cog home surface in the configured course guild.");
