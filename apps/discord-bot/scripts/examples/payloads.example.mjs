// Runnable example: what CogBot's Discord command payloads look like, and the
// invariants the Worker relies on. Runs with no credentials and no network:
//
//   node scripts/examples/payloads.example.mjs
//
// The "view" choice values must track the View union in src/commands.ts
// (`type View = "home" | "leaderboard" | "benchmarks" | "local" | "connect"`).
// If that union changes, update scripts/command-payloads.mjs to match — this
// example fails loudly when the two drift apart.
import assert from "node:assert/strict";
import { cogCommand, entryPointCommand } from "../command-payloads.mjs";

const VIEW_CHOICES = ["home", "leaderboard", "benchmarks", "local", "connect"];

function checkPayloads() {
  assert.equal(cogCommand.type, 1, "cogCommand.type should be 1 (chat input command)");
  assert.equal(cogCommand.name, "cog", 'cogCommand.name should be "cog"');

  const options = cogCommand.options ?? [];
  assert.equal(options.length, 1, "cogCommand should declare exactly one option");
  const view = options[0];
  assert.equal(view.name, "view", 'the single cogCommand option should be named "view"');
  assert.deepEqual(
    (view.choices ?? []).map((choice) => choice.value),
    VIEW_CHOICES,
    "the view choice values must track the View union in src/commands.ts",
  );

  assert.equal(entryPointCommand.type, 4, "entryPointCommand.type should be 4 (primary entry point)");
  assert.equal(entryPointCommand.handler, 1, "entryPointCommand.handler should be 1 (APP_HANDLER)");
  assert.deepEqual(
    entryPointCommand.integration_types,
    [0, 1],
    "entryPointCommand should install for both guild (0) and user (1) integrations",
  );
  assert.deepEqual(
    entryPointCommand.contexts,
    [0, 1, 2],
    "entryPointCommand should be usable in guilds (0), DMs with the app (1), and DMs (2)",
  );
}

try {
  checkPayloads();
} catch (error) {
  console.error(`payloads.example: mismatch: ${error.message}`);
  process.exit(1);
}

const view = (cogCommand.options ?? [])[0];
console.log(
  `cogCommand: type ${cogCommand.type} chat input "/${cogCommand.name}" with one option "${view.name}" ` +
    `(${view.choices.length} choices: ${view.choices.map((choice) => choice.value).join(", ")})`,
);
console.log(
  `entryPointCommand: type ${entryPointCommand.type} primary entry point "/${entryPointCommand.name}" ` +
    `(handler ${entryPointCommand.handler}, integration types [${entryPointCommand.integration_types.join(", ")}], ` +
    `contexts [${entryPointCommand.contexts.join(", ")}])`,
);
