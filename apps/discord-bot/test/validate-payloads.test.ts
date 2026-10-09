import assert from "node:assert/strict";
import { test } from "node:test";
import { cogCommand, entryPointCommand } from "../scripts/command-payloads.mjs";
import {
  CommandPayloadValidationError,
  PAYLOAD_LIMITS,
  validateCommandPayload,
} from "../scripts/validate-payloads.mjs";

type AnyPayload = Record<string, unknown>;

function chatInput(overrides: AnyPayload = {}): AnyPayload {
  return { type: 1, name: "cog", description: "Open your CogWorks lab bench", ...overrides };
}

function entryPoint(overrides: AnyPayload = {}): AnyPayload {
  return {
    type: 4,
    name: "launch",
    description: "Open the CogWorks live bench",
    handler: 1,
    integration_types: [0, 1],
    contexts: [0, 1, 2],
    ...overrides,
  };
}

function choiceList(count: number): AnyPayload[] {
  return Array.from({ length: count }, (_, index) => ({
    name: `Choice ${index}`,
    value: `choice-${index}`,
  }));
}

function choicePicker(count: number): AnyPayload {
  return chatInput({
    options: [
      { type: 3, name: "view", description: "Go straight to a view", choices: choiceList(count) },
    ],
  });
}

function optionList(count: number): AnyPayload[] {
  return Array.from({ length: count }, (_, index) => ({
    type: 3,
    name: `option-${index}`,
    description: `Option number ${index}`,
  }));
}

function expectValidationError(payload: unknown): CommandPayloadValidationError {
  try {
    validateCommandPayload(payload);
  } catch (error) {
    assert.ok(
      error instanceof CommandPayloadValidationError,
      `threw ${error} instead of CommandPayloadValidationError`,
    );
    return error;
  }
  assert.fail("expected validateCommandPayload to throw CommandPayloadValidationError");
}

function expectIssue(payload: unknown, path: string, fragment: string): void {
  const error = expectValidationError(payload);
  const issue = error.errors.find((candidate) => candidate.path === path);
  assert.ok(issue, `expected an issue at ${path}, got ${JSON.stringify(error.errors)}`);
  assert.ok(
    issue.message.includes(fragment),
    `expected the issue at ${path} to mention ${JSON.stringify(fragment)}, got ${JSON.stringify(issue.message)}`,
  );
  assert.ok(error.message.includes(path), `rendered message must include the path: ${error.message}`);
  assert.ok(
    error.message.includes(fragment),
    `rendered message must include ${JSON.stringify(fragment)}: ${error.message}`,
  );
}

test("real registered payloads validate clean and pass through unchanged", () => {
  assert.equal(validateCommandPayload(cogCommand), cogCommand);
  assert.equal(validateCommandPayload(entryPointCommand), entryPointCommand);
});

test("PAYLOAD_LIMITS matches the Discord application command limits", () => {
  assert.deepEqual(PAYLOAD_LIMITS, {
    nameMaxLength: 32,
    descriptionMaxLength: 100,
    maxOptions: 25,
    maxChoices: 25,
    choiceNameMaxLength: 100,
    choiceValueMaxLength: 100,
  });
});

test("a 32 character name passes and a 33 character name fails", () => {
  const atLimit = chatInput({ name: "a".repeat(32) });
  assert.equal(validateCommandPayload(atLimit), atLimit);
  expectIssue(chatInput({ name: "a".repeat(33) }), "name", "must be 1 to 32 chars");
});

test("a 100 character description passes and a 101 character description fails", () => {
  const atLimit = chatInput({ description: "d".repeat(100) });
  assert.equal(validateCommandPayload(atLimit), atLimit);
  expectIssue(chatInput({ description: "d".repeat(101) }), "description", "must be 1 to 100 chars");
});

test("25 options pass and 26 options fail", () => {
  const atLimit = chatInput({ options: optionList(25) });
  assert.equal(validateCommandPayload(atLimit), atLimit);
  expectIssue(chatInput({ options: optionList(26) }), "options", "must have at most 25 options");
});

test("25 choices pass, 26 choices fail, and an empty choices array passes", () => {
  const atLimit = choicePicker(25);
  assert.equal(validateCommandPayload(atLimit), atLimit);
  expectIssue(choicePicker(26), "options.0.choices", "must have at most 25 choices");
  const emptyChoices = choicePicker(0);
  assert.equal(validateCommandPayload(emptyChoices), emptyChoices);
});

test("type must be 1 or 4", () => {
  expectIssue(chatInput({ type: 2 }), "type", "must be 1 or 4");
  expectIssue(chatInput({ type: "1" }), "type", "must be 1 or 4");
  expectIssue({ name: "cog", description: "Open your CogWorks lab bench" }, "type", "must be 1 or 4");
});

test("a name must be a lowercase string of allowed characters", () => {
  expectIssue(chatInput({ name: undefined }), "name", "is required");
  expectIssue(chatInput({ name: 123 }), "name", "must be a string");
  expectIssue(chatInput({ name: "Cog" }), "name", "must be lowercase");
  expectIssue(
    chatInput({ name: "cog view" }),
    "name",
    "must contain only letters, numbers, hyphens, and underscores",
  );
});

test("a description must be a bounded string", () => {
  expectIssue(chatInput({ description: undefined }), "description", "is required");
  expectIssue(chatInput({ description: 42 }), "description", "must be a string");
});

test("options must be an array of valid option objects", () => {
  expectIssue(chatInput({ options: 5 }), "options", "must be an array");
  expectIssue(chatInput({ options: ["view"] }), "options.0", "must be an object");
  expectIssue(
    chatInput({ options: [{ type: 3, name: "v".repeat(33), description: "d" }] }),
    "options.0.name",
    "must be 1 to 32 chars",
  );
  expectIssue(
    chatInput({ options: [{ type: 3, name: "view", description: "d".repeat(101) }] }),
    "options.0.description",
    "must be 1 to 100 chars",
  );
  expectIssue(
    chatInput({ options: [{ type: 11, name: "view", description: "d" }] }),
    "options.0.type",
    "must be an integer from 1 to 10",
  );
  expectIssue(
    chatInput({ options: [{ type: 3.5, name: "view", description: "d" }] }),
    "options.0.type",
    "must be an integer from 1 to 10",
  );
  expectIssue(
    chatInput({ options: [{ type: "3", name: "view", description: "d" }] }),
    "options.0.type",
    "must be a number",
  );
  expectIssue(
    chatInput({ options: [{ type: 3, name: "view", description: "d", required: "yes" }] }),
    "options.0.required",
    "must be a boolean",
  );
});

test("choices must be an array of bounded name and value pairs", () => {
  expectIssue(
    chatInput({ options: [{ type: 3, name: "view", description: "d", choices: 5 }] }),
    "options.0.choices",
    "must be an array",
  );
  expectIssue(
    chatInput({
      options: [{ type: 3, name: "view", description: "d", choices: [{ name: "n".repeat(101), value: "ok" }] }],
    }),
    "options.0.choices.0.name",
    "must be 1 to 100 chars",
  );
  expectIssue(
    chatInput({
      options: [{ type: 3, name: "view", description: "d", choices: [{ name: "Name", value: 7 }] }],
    }),
    "options.0.choices.0.value",
    "must be a string",
  );
  expectIssue(
    chatInput({
      options: [{ type: 3, name: "view", description: "d", choices: [{ name: "Name", value: "v".repeat(101) }] }],
    }),
    "options.0.choices.0.value",
    "must be 1 to 100 chars",
  );
});

test("an entry point handler must be exactly 1", () => {
  expectIssue(entryPoint({ handler: 2 }), "handler", "must be exactly 1");
  expectIssue(entryPoint({ handler: undefined }), "handler", "must be exactly 1");
});

test("entry point integration_types accept only 0 and 1", () => {
  expectIssue(entryPoint({ integration_types: [0, 2] }), "integration_types.1", "must be 0 or 1");
  expectIssue(entryPoint({ integration_types: 0 }), "integration_types", "must be an array");
});

test("entry point contexts accept only 0, 1, and 2", () => {
  expectIssue(entryPoint({ contexts: [0, 1, 3] }), "contexts.2", "must be 0, 1, or 2");
  expectIssue(entryPoint({ contexts: "global" }), "contexts", "must be an array");
});

test("entry point payloads must not carry options", () => {
  expectIssue(entryPoint({ options: [] }), "options", "must be absent");
});

test("entry point name and description are optional but validated when present", () => {
  const minimal = { type: 4, handler: 1, integration_types: [0], contexts: [0] };
  assert.equal(validateCommandPayload(minimal), minimal);
  expectIssue(entryPoint({ name: "Launch" }), "name", "must be lowercase");
});

test("unknown keys fail loudly on both payload shapes", () => {
  expectIssue(chatInput({ integration_tpyes: [0, 1] }), "integration_tpyes", "is not a recognized property");
  expectIssue(
    entryPoint({ integration_tpyes: [0, 1] }),
    "integration_tpyes",
    "is not a recognized property",
  );
  expectIssue(
    chatInput({ options: [{ type: 3, name: "view", description: "d", nmae: "view" }] }),
    "options.0.nmae",
    "is not a recognized property",
  );
});

test("non-object payloads fail with a root issue", () => {
  for (const bad of [null, "cog", 42, []]) {
    expectIssue(bad, "", "must be a command payload object");
  }
});

test("one throw lists every issue with its path and renders each as path: message", () => {
  const error = expectValidationError(chatInput({ name: "Cog", description: "" }));
  assert.equal(error.errors.length, 2);
  assert.ok(
    error.errors.some((issue) => issue.path === "name" && issue.message.includes("must be lowercase")),
  );
  assert.ok(
    error.errors.some(
      (issue) => issue.path === "description" && issue.message.includes("must be 1 to 100 chars"),
    ),
  );
  assert.ok(error.message.startsWith("invalid command payload: "));
  assert.ok(error.message.includes("name: must be lowercase per Discord command naming"));
  assert.ok(error.message.includes("description: must be 1 to 100 chars"));
});

test("the error exposes its issues in a stable shape", () => {
  const error = expectValidationError({ type: 2 });
  assert.ok(error instanceof Error);
  assert.equal(error.name, "CommandPayloadValidationError");
  assert.deepEqual(error.errors, [{ path: "type", message: "must be 1 or 4" }]);
});
