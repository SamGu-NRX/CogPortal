/**
 * Payload for the /cog chat-input command registered in the course guild.
 *
 * register-commands.mjs PUTs this payload (as a one-element array) to the
 * guild-commands endpoint for COURSE_GUILD_ID. A PUT to that endpoint is a
 * bulk overwrite, so /cog is always the only guild command CogBot exposes
 * there.
 *
 * The optional view option is a string select whose values are view ids the
 * Worker routes on: commands.ts reads the "view" option and matches it
 * against the View union and the VIEW_IDS set (src/commands.ts around lines
 * 19 and 24), falling back to "home" for anything unrecognized. These
 * choices and that union must stay in lockstep. Adding a view means
 * updating src/commands.ts, the test expectations, and this payload
 * together.
 *
 * Discord field meanings: type 1 is a chat-input command; the option's
 * type 3 is a string parameter.
 */
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

/**
 * Payload for the global launch Activity Entry Point command.
 *
 * This is the "launch" entry under the app's Activity launcher. handler 1
 * (APP_HANDLER) means CogBot itself receives the interaction and answers
 * with the LAUNCH_ACTIVITY callback (type 12, defined in
 * src/interaction.ts) so the CogWorks Activity opens through the Worker
 * rather than Discord opening an Activity on its own. src/index.ts detects
 * the command by interaction.data.type === 4 and currently restricts it to
 * the course guild.
 *
 * integration_types [0, 1] cover guild installs and user installs;
 * contexts [0, 1, 2] make the command usable in guild chat, bot DMs, and
 * private channels. Any further gating happens in the Worker, not here.
 *
 * register-commands.mjs registers this globally: it PATCHes the existing
 * type-4 command when one is already on the application, otherwise it
 * POSTs this payload to the command collection.
 *
 * Discord field meanings: type 4 is the Activity Entry Point command;
 * handler 1 is APP_HANDLER; integration_types 0 and 1 are guild install
 * and user install; contexts 0, 1, and 2 are guild, bot DM, and private
 * channel.
 */
export const entryPointCommand = {
  type: 4,
  name: "launch",
  description: "Open the CogWorks live bench",
  handler: 1,
  integration_types: [0, 1],
  contexts: [0, 1, 2],
};
