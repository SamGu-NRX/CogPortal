import assert from "node:assert/strict";
import { test } from "node:test";
import { cogCommand, entryPointCommand } from "../scripts/command-payloads.mjs";
import {
  INTERACTION_APPLICATION_COMMAND,
  INTERACTION_MESSAGE_COMPONENT,
  RESPONSE_CHANNEL_MESSAGE,
  RESPONSE_DEFERRED_CHANNEL_MESSAGE,
  RESPONSE_LAUNCH_ACTIVITY,
  launchActivity,
} from "../src/interaction.ts";

// Consistency guards between scripts/command-payloads.mjs and the code that consumes
// it: src/interaction.ts, src/commands.ts, src/index.ts, scripts/register-commands.mjs,
// and the README experience contract. A drift fails here instead of confusing an
// instructor at registration time.

type ViewOptionSpec = {
  type: number;
  name: string;
  choices?: { name: string; value: string }[];
};

test("payload command types stay in the command namespace the worker routes on", () => {
  // interaction.ts:55: application commands arrive as interaction type 2.
  assert.equal(INTERACTION_APPLICATION_COMMAND, 2);
  // interaction.ts:56: message components arrive as interaction type 3.
  assert.equal(INTERACTION_MESSAGE_COMPONENT, 3);
  // command-payloads.mjs:2: /cog is a chat-input command, command type 1. Command
  // types and the interaction types above are different namespaces; never merge them.
  assert.equal(cogCommand.type, 1);
  // command-payloads.mjs:3: the name index.ts:90 matches as the /cog front door.
  assert.equal(cogCommand.name, "cog");
  // command-payloads.mjs:24: the Activity Entry Point is command type 4;
  // register-commands.mjs:21 finds the live command by that type and index.ts:88
  // matches data.type === 4 when the interaction arrives.
  assert.equal(entryPointCommand.type, 4);
});

test("the cog view option carries exactly the views commands.ts routes on", () => {
  // command-payloads.d.mts types options loosely; narrow to read the single option.
  const viewOption = cogCommand.options?.[0] as ViewOptionSpec | undefined;
  assert.ok(viewOption, "cogCommand must declare the view option");

  // command-payloads.mjs:7: option type 3 is a string option in the option-type
  // namespace, so commands.ts stringOption receives string values.
  assert.equal(viewOption.type, 3);
  // command-payloads.mjs:8: the option name commands.ts:409 reads with
  // stringOption(interaction.data?.options, "view").
  assert.equal(viewOption.name, "view");
  // command-payloads.mjs:12-16: choice values are exactly the View union
  // (commands.ts:37, VIEW_IDS at commands.ts:42); anything else falls back to
  // "home" at commands.ts:410 and silently ignores the student's pick.
  assert.deepEqual(
    viewOption.choices?.map((choice) => choice.value),
    ["home", "leaderboard", "benchmarks", "local", "connect"],
  );
});

test("the entry point handler stays app-handled so the worker answers with the launch callback", () => {
  // command-payloads.mjs:27: handler 1 is the app-handled contract also pinned by
  // test/commands.test.ts:336; the comment at command-payloads.mjs:22 promises
  // LAUNCH_ACTIVITY instead of a channel post.
  assert.equal(entryPointCommand.handler, 1);
  // interaction.ts:62: index.ts:97 answers the entry point with launchActivity(),
  // so the app-handled response is the launch callback (12).
  const launchType = launchActivity().type;
  assert.equal(launchType, RESPONSE_LAUNCH_ACTIVITY);
  // interaction.ts:58: never a synchronous channel message.
  assert.notEqual(launchType, RESPONSE_CHANNEL_MESSAGE);
  // interaction.ts:59: and never a deferred channel post either.
  assert.notEqual(launchType, RESPONSE_DEFERRED_CHANNEL_MESSAGE);
});

test("entry point contexts cover the course guild plus the private surfaces", () => {
  // command-payloads.mjs:29: contexts 0 (guild), 1 (bot DM), 2 (private channel).
  assert.deepEqual(entryPointCommand.contexts, [0, 1, 2]);
  // Context 0 must stay present: index.ts:98 gates the launch on the course guild,
  // and the README's one shared live-run message (apps/discord-bot/README.md:14)
  // lives in a guild channel.
  assert.ok(entryPointCommand.contexts?.includes(0));
  // Contexts 1 and 2 keep the README private-by-default surfaces
  // (apps/discord-bot/README.md:10) reachable outside the guild channel.
  assert.ok(entryPointCommand.contexts?.includes(1) && entryPointCommand.contexts?.includes(2));
});

test("entry point integration types cover guild and user install", () => {
  // command-payloads.mjs:28: 0 is guild install, 1 is user install;
  // register-commands.mjs:23-28 registers the entry point at the application
  // level, where this install scope applies.
  assert.deepEqual(entryPointCommand.integration_types, [0, 1]);
});
