export const cogCommand = {
  type: 1,
  name: "cog",
  description: "Open your CogWorks lab bench",
  // Guild install only (0). The app is course-guild-only (README); a user install (1) would offer
  // CogBot in servers and DMs where every request is refused for lacking the course guild.
  integration_types: [0],
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

// APP_HANDLER lets CogBot answer with LAUNCH_ACTIVITY instead of a channel post.
export const entryPointCommand = {
  type: 4,
  name: "launch",
  description: "Open the CogWorks live bench",
  handler: 1,
  // Guild install only, for the same reason as /cog above.
  integration_types: [0],
  // The launch handler requires COURSE_GUILD_ID; DMs have no guild to authorize.
  contexts: [0],
};
