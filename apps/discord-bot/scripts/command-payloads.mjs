export const cogCommand = {
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

// APP_HANDLER lets CogBot answer with LAUNCH_ACTIVITY instead of a channel post.
export const entryPointCommand = {
  type: 4,
  name: "launch",
  description: "Open the CogWorks live bench",
  handler: 1,
  integration_types: [0, 1],
  contexts: [0, 1, 2],
};
