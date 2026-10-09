import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { test } from "node:test";
import { cogCommand, entryPointCommand } from "../scripts/command-payloads.mjs";

// The registration payloads are plain objects shared with scripts/register-commands.mjs
// and typed loosely in scripts/command-payloads.d.mts. This is only what the test reads
// out of them; the key-set assertions below pin the rest.
// Type aliases, not interfaces: TS gives object-literal aliases an implicit index
// signature, so the single cast from the payload's loose Record shape below is honest.
type ChoiceLike = {
  name: string;
  value: string;
};

type OptionLike = {
  type: number;
  name: string;
  required?: boolean;
  choices?: ChoiceLike[];
};

interface ViewRouting {
  // Views the option resolver accepts (VIEW_IDS), and the subset of those with a case
  // in the executeCommand switch, so an accepted but unrouted view cannot hide here.
  acceptedViews: string[];
  routedViews: string[];
}

// Reads the routing source at test time so the view set compared against the payload is
// the one the code routes on, not a copy that can drift the same way the payload can.
// String paths only: the workers-types global URL type does not match node's fs overload.
const routingSource = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "../src/commands.ts"),
  "utf8",
);

function quotedStrings(text: string): string[] {
  return [...text.matchAll(/"([^"]+)"/g)].map((match) => match[1]);
}

function optionViewRouting(source: string): ViewRouting {
  const setMatch = source.match(/const VIEW_IDS = new Set<View>\(\[([^\]]*)\]/);
  assert.ok(setMatch, "VIEW_IDS set literal not found in src/commands.ts");
  const acceptedViews = quotedStrings(setMatch[1]);

  const typeMatch = source.match(/^type View = ([^;]+);$/m);
  assert.ok(typeMatch, "type View union not found in src/commands.ts");
  assert.deepEqual(quotedStrings(typeMatch[1]).sort(), [...acceptedViews].sort(), "type View and VIEW_IDS disagree in src/commands.ts");

  const switchStart = source.indexOf("switch (requestedView(interaction))");
  assert.ok(switchStart >= 0, "executeCommand switch not found in src/commands.ts");
  const routedCases = [...source.slice(switchStart).matchAll(/case "([^"]+)"/g)].map((match) => match[1]);

  return {
    acceptedViews,
    routedViews: acceptedViews.filter((view) => routedCases.includes(view)),
  };
}

test("cogCommand is the one /cog payload the router answers", () => {
  // src/commands.ts routing: register-commands.mjs sends this object to Discord as the
  // whole guild command set, so a surprise key goes live unreviewed.
  assert.deepEqual(Object.keys(cogCommand).sort(), ["description", "name", "options", "type"]);

  // src/commands.ts routing: executeCommand only ever answers the interaction named cog.
  assert.equal(cogCommand.name, "cog");

  // src/commands.ts routing: type 1 (CHAT_INPUT) is the slash-command shape the router resolves.
  assert.equal(cogCommand.type, 1);

  // apps/discord-bot/README.md: Discord rejects an empty command description and caps it at 100 characters.
  assert.ok(cogCommand.description.length >= 1 && cogCommand.description.length <= 100, "description must be 1..100 characters");
});

test("the view option stays in lockstep with the views executeCommand routes", () => {
  const options = (cogCommand.options ?? []) as OptionLike[];
  // src/commands.ts routing: the router resolves one option named view; any other name is invisible to it.
  const viewOptions = options.filter((option) => option.name === "view");
  assert.equal(viewOptions.length, 1);

  const viewOption = viewOptions[0];
  // src/commands.ts routing: stringOption() reads a type 3 (string) option.
  assert.equal(viewOption.type, 3);

  // apps/discord-bot/README.md: the view picker is a shortcut, not required knowledge.
  assert.equal(viewOption.required, false);

  const values = (viewOption.choices ?? []).map((choice) => choice.value);
  // src/commands.ts routing: an unknown value silently falls back to home, so a duplicate
  // choice would shadow every choice listed after it.
  assert.equal(new Set(values).size, values.length, "view choice values must be unique");

  const { acceptedViews, routedViews } = optionViewRouting(routingSource);
  // src/commands.ts routing: every choice must be a view executeCommand routes on, or
  // picking it quietly lands the student on home.
  for (const value of values) {
    assert.ok(routedViews.includes(value), `choice "${value}" is not a view executeCommand routes on`);
  }
  // src/commands.ts routing: every routed view must be a choice, or it is unreachable
  // from the /cog picker.
  for (const view of routedViews) {
    assert.ok(values.includes(view), `view "${view}" routes in executeCommand but is not a choice value`);
  }
  // src/commands.ts routing: a view VIEW_IDS accepts must have a case in executeCommand,
  // or the switch falls through and returns undefined.
  assert.equal(acceptedViews.length, routedViews.length, "a VIEW_IDS member has no case in executeCommand");
});

test("entryPointCommand keeps the app-handled Activity launch contract", () => {
  // apps/discord-bot/README.md: register-commands.mjs sends this object to Discord, so
  // a surprise key goes live unreviewed.
  assert.deepEqual(
    Object.keys(entryPointCommand).sort(),
    ["contexts", "description", "handler", "integration_types", "name", "type"],
  );

  // the existing commands test: "the Activity Entry Point is app-handled to avoid an
  // extra channel message" asserts type 4 with handler 1.
  assert.equal(entryPointCommand.type, 4);
  assert.equal(entryPointCommand.handler, 1);

  // apps/discord-bot/README.md: installable as a guild app (0) and a user app (1).
  for (const kind of [0, 1]) {
    assert.ok(entryPointCommand.integration_types?.includes(kind), `integration_types must contain ${kind}`);
  }

  // apps/discord-bot/README.md: usable in a guild (0), a bot DM (1), and a private channel (2).
  for (const context of [0, 1, 2]) {
    assert.ok(entryPointCommand.contexts?.includes(context), `contexts must contain ${context}`);
  }

  // apps/discord-bot/README.md: the Activity front door is launch.
  assert.equal(entryPointCommand.name, "launch");
});
