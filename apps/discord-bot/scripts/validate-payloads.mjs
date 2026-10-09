// Runtime guard for the Discord command payloads this package registers
// (scripts/command-payloads.mjs). register-commands.mjs sends those payloads to
// the Discord API, and a malformed one comes back as a bare HTTP 400 that says
// nothing about which field broke. Validating right before the request turns
// that into one error naming every bad field and its path.
//
// Limits follow the Discord application command rules
// (https://discord.com/developers/docs/interactions/application-commands).
// Schemas use zod strict objects on purpose: unknown keys are rejected, so a
// typo like `integration_tpyes` fails here instead of silently doing nothing on
// Discord's side.
//
// Expected wiring: `validateCommandPayload(payload)` immediately before each
// `JSON.stringify(payload)` handed to a Discord API fetch.

import { z } from "zod";

/**
 * Discord application command limits, by value, so schemas and error messages
 * quote one source instead of restating numbers.
 *
 * @type {{
 *   nameMaxLength: number,
 *   descriptionMaxLength: number,
 *   maxOptions: number,
 *   maxChoices: number,
 *   choiceNameMaxLength: number,
 *   choiceValueMaxLength: number,
 * }}
 */
export const PAYLOAD_LIMITS = {
  nameMaxLength: 32,
  descriptionMaxLength: 100,
  maxOptions: 25,
  maxChoices: 25,
  choiceNameMaxLength: 100,
  choiceValueMaxLength: 100,
};

/**
 * One validation failure: where it happened (a dot path into the payload, for
 * example "options.0.choices.2.value") and what is wrong there.
 *
 * @typedef {object} CommandPayloadIssue
 * @property {string} path Dot path into the payload. Empty string for failures
 *   about the payload itself, such as a non-object payload.
 * @property {string} message What is wrong at that path.
 */

/**
 * @param {string} expected
 * @returns {(issue: { input?: unknown }) => string} A zod error function that
 *   distinguishes a missing key from a value of the wrong type.
 */
function fieldError(expected) {
  return (issue) => (issue.input === undefined ? "is required" : `must be ${expected}`);
}

/**
 * A required string with explicit bounds and one shared length message.
 *
 * @param {number} minLength
 * @param {number} maxLength
 * @param {string} lengthMessage
 * @returns {z.ZodString}
 */
function boundedString(minLength, maxLength, lengthMessage) {
  return z
    .string({ error: fieldError("a string") })
    .min(minLength, lengthMessage)
    .max(maxLength, lengthMessage);
}

// Discord command names allow letters, numbers, hyphens, and underscores, and
// reject uppercase letters. The regex keeps empty strings for the length check
// to report, so an empty name does not produce two issues.
const commandNameSchema = z
  .string({ error: fieldError("a string") })
  .min(1, `must be 1 to ${PAYLOAD_LIMITS.nameMaxLength} chars`)
  .max(PAYLOAD_LIMITS.nameMaxLength, `must be 1 to ${PAYLOAD_LIMITS.nameMaxLength} chars`)
  .regex(/^[-_\p{L}\p{N}]*$/u, "must contain only letters, numbers, hyphens, and underscores")
  .refine((value) => value === value.toLowerCase(), "must be lowercase per Discord command naming");

const descriptionSchema = boundedString(
  1,
  PAYLOAD_LIMITS.descriptionMaxLength,
  `must be 1 to ${PAYLOAD_LIMITS.descriptionMaxLength} chars`,
);

const choiceSchema = z.strictObject(
  {
    name: boundedString(
      1,
      PAYLOAD_LIMITS.choiceNameMaxLength,
      `must be 1 to ${PAYLOAD_LIMITS.choiceNameMaxLength} chars`,
    ),
    value: boundedString(
      1,
      PAYLOAD_LIMITS.choiceValueMaxLength,
      `must be 1 to ${PAYLOAD_LIMITS.choiceValueMaxLength} chars`,
    ),
  },
  { error: "must be an object" },
);

const optionSchema = z.strictObject(
  {
    name: boundedString(
      1,
      PAYLOAD_LIMITS.nameMaxLength,
      `must be 1 to ${PAYLOAD_LIMITS.nameMaxLength} chars`,
    ),
    description: descriptionSchema,
    type: z
      .number({ error: fieldError("a number") })
      .refine(
        (value) => Number.isInteger(value) && value >= 1 && value <= 10,
        "must be an integer from 1 to 10",
      ),
    required: z.boolean({ error: fieldError("a boolean") }).optional(),
    choices: z
      .array(choiceSchema, { error: fieldError("an array") })
      .max(PAYLOAD_LIMITS.maxChoices, `must have at most ${PAYLOAD_LIMITS.maxChoices} choices`)
      .optional(),
  },
  { error: "must be an object" },
);

// Type 1 (CHAT_INPUT): the /cog slash command surface.
const chatInputSchema = z.strictObject({
  type: z.literal(1, "must be 1 or 4"),
  name: commandNameSchema,
  description: descriptionSchema,
  options: z
    .array(optionSchema, { error: fieldError("an array") })
    .max(PAYLOAD_LIMITS.maxOptions, `must have at most ${PAYLOAD_LIMITS.maxOptions} options`)
    .optional(),
});

// Type 4 (primary entry point): the Activity launch payload. name and
// description are not required by the entry point contract but are validated
// with the same rules when present.
const entryPointSchema = z.strictObject({
  type: z.literal(4, "must be 1 or 4"),
  name: commandNameSchema.optional(),
  description: descriptionSchema.optional(),
  handler: z.literal(1, "must be exactly 1"),
  integration_types: z.array(
    z
      .number({ error: fieldError("a number") })
      .refine((value) => value === 0 || value === 1, "must be 0 or 1"),
    { error: fieldError("an array") },
  ),
  contexts: z.array(
    z
      .number({ error: fieldError("a number") })
      .refine((value) => value === 0 || value === 1 || value === 2, "must be 0, 1, or 2"),
    { error: fieldError("an array") },
  ),
  options: z.optional(z.never({ error: "must be absent on an entry point payload" })),
});

const commandPayloadSchema = z.discriminatedUnion("type", [chatInputSchema, entryPointSchema], {
  error: (issue) => (issue.path?.length ? "must be 1 or 4" : "must be a command payload object"),
});

/**
 * @param {PropertyKey[]} parts
 * @param {string} [key]
 * @returns {string}
 */
function joinPath(parts, key) {
  const all = key === undefined ? parts : [...parts, key];
  return all.map(String).join(".");
}

/**
 * Maps one zod issue to payload issues. Unrecognized-key issues report the
 * object as their location, so each unknown key gets its own entry with the
 * key as the path instead of a root issue that hides where to look.
 *
 * @param {z.core.$ZodIssue} zodIssue
 * @returns {CommandPayloadIssue[]}
 */
function toPayloadIssues(zodIssue) {
  if (zodIssue.code === "unrecognized_keys" && Array.isArray(zodIssue.keys) && zodIssue.keys.length > 0) {
    return zodIssue.keys.map((key) => ({
      path: joinPath(zodIssue.path, key),
      message: "is not a recognized property of this payload",
    }));
  }
  return [{ path: joinPath(zodIssue.path), message: zodIssue.message }];
}

/**
 * @param {CommandPayloadIssue} issue
 * @returns {string} One rendered line, "path: message", or just "message"
 *   when the issue is about the payload itself.
 */
function formatIssue(issue) {
  return issue.path ? `${issue.path}: ${issue.message}` : issue.message;
}

/**
 * @param {CommandPayloadIssue[]} errors
 * @returns {string} The full error message, every issue rendered after the
 *   prefix, for example:
 *   "invalid command payload: name: must be 1 to 32 chars; description: must be 1 to 100 chars"
 */
function renderMessage(errors) {
  const lines = errors.map(formatIssue);
  return lines.length > 0 ? `invalid command payload: ${lines.join("; ")}` : "invalid command payload";
}

/**
 * Thrown by validateCommandPayload when a payload violates the command
 * contract. Collects every issue at once, so one send attempt reports all
 * broken fields instead of the first one.
 */
export class CommandPayloadValidationError extends Error {
  /**
   * @param {CommandPayloadIssue[]} errors Every issue found, in schema order.
   */
  constructor(errors) {
    super(renderMessage(errors));
    this.name = "CommandPayloadValidationError";
    /** @type {CommandPayloadIssue[]} */
    this.errors = errors;
  }
}

/**
 * Validates a Discord application command payload against the shapes this
 * package registers: type 1 (slash command) and type 4 (primary entry point).
 * Both shapes reject unknown keys, so misspelled properties fail loudly.
 *
 * @param {unknown} payload The candidate payload, usually straight from
 *   scripts/command-payloads.mjs or hand-written in a deploy script.
 * @returns {unknown} The input object, unchanged. Validation only; keep using
 *   the original reference after this call.
 * @throws {CommandPayloadValidationError} With one issue per broken field,
 *   each carrying its dot path into the payload.
 */
export function validateCommandPayload(payload) {
  const result = commandPayloadSchema.safeParse(payload);
  if (result.success) {
    return payload;
  }
  throw new CommandPayloadValidationError(result.error.issues.flatMap(toPayloadIssues));
}
