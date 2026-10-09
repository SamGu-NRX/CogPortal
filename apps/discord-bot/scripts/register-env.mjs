// Validation for the environment that scripts/register-commands.mjs reads.
// process.env is a trust boundary: a truthiness check once let a whitespace-only
// or malformed value through, and the mistake surfaced later as a confusing
// Discord 401 or 404. Every problem is collected and reported at once, and each
// message names the one next action.
import { z } from "zod";

/**
 * A single validation problem.
 *
 * @typedef {object} RegistrationEnvIssue
 * @property {string} field Environment variable the problem belongs to; a
 *   comma-separated list when one problem covers several variables.
 * @property {string} message What is wrong and the one next action.
 */

/**
 * Thrown when the command-registration environment is missing or malformed.
 * The `message` lists every problem on its own line; `issues` carries the same
 * problems one by one for programmatic use.
 */
export class RegistrationEnvError extends Error {
  /** @type {RegistrationEnvIssue[]} */
  issues;

  /**
   * @param {RegistrationEnvIssue[]} issues Every problem found, in field order.
   */
  constructor(issues) {
    super(
      ["Invalid registration environment:", ...issues.map((issue) => issue.message)].join("\n"),
    );
    this.name = "RegistrationEnvError";
    this.issues = issues;
  }
}

const SNOWFLAKE_PATTERN = /^\d{5,25}$/;
const TOKEN_MIN_LENGTH = 50;
const BOT_PREFIX = "Bot ";

/** Order matches the variables register-commands.mjs reads. */
const FIELD_NAMES = ["DISCORD_APPLICATION_ID", "DISCORD_BOT_TOKEN", "COURSE_GUILD_ID"];

/**
 * A variable counts as missing when it is absent or empty, matching the
 * truthiness check this module replaces.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
function isMissing(value) {
  return value === undefined || value === null || value === "";
}

/**
 * Echo helper for public snowflake values only; never used for the token.
 *
 * @param {unknown} value
 * @returns {string}
 */
function display(value) {
  const text = typeof value === "string" ? value : String(value);
  return text.length > 64 ? `${text.slice(0, 64)}...` : text;
}

/**
 * @param {string} name Environment variable name.
 * @param {string} value A present, string value.
 * @returns {string | null} The whitespace problem, or null when the value is clean.
 */
function whitespaceIssue(name, value) {
  if (value.trim() === "") {
    return `${name} is present but contains only whitespace; set it to the bare value with no surrounding whitespace.`;
  }
  if (value !== value.trim()) {
    return `${name} has surrounding whitespace; remove it and set the variable to the bare value.`;
  }
  return null;
}

/**
 * @param {string} name Environment variable name.
 * @param {string} what Human-readable Discord ID kind ("application ID" or "guild ID").
 * @returns {(value: unknown) => string | null}
 */
function snowflakeRule(name, what) {
  return (value) => {
    if (typeof value !== "string") {
      return `${name} must be a Discord ${what} (a numeric snowflake), got ${display(value)}.`;
    }
    const whitespace = whitespaceIssue(name, value);
    if (whitespace !== null) {
      return whitespace;
    }
    if (!SNOWFLAKE_PATTERN.test(value)) {
      return `${name} must be a Discord ${what} (a numeric snowflake), got ${display(value)}.`;
    }
    return null;
  };
}

/**
 * Token messages never echo token content; they name counts and shapes only.
 *
 * @param {unknown} value
 * @returns {string | null}
 */
function tokenRule(value) {
  if (typeof value !== "string") {
    return `DISCORD_BOT_TOKEN must be the raw bot token: a string of at least ${TOKEN_MIN_LENGTH} characters with no whitespace.`;
  }
  const whitespace = whitespaceIssue("DISCORD_BOT_TOKEN", value);
  if (whitespace !== null) {
    return whitespace;
  }
  if (value.startsWith(BOT_PREFIX)) {
    return `DISCORD_BOT_TOKEN starts with "Bot ", so the Bot prefix is included; pass the raw token without the Bot prefix.`;
  }
  if (/\s/.test(value)) {
    return `DISCORD_BOT_TOKEN must not contain whitespace; copy the raw token again without any spaces or newlines.`;
  }
  if (value.length < TOKEN_MIN_LENGTH) {
    return `DISCORD_BOT_TOKEN must be at least ${TOKEN_MIN_LENGTH} characters, got ${value.length} characters.`;
  }
  return null;
}

/**
 * A field schema that reports at most one issue, with missing values left to
 * the combined missing-variables message.
 *
 * @param {(value: unknown) => string | null} rule
 * @returns {z.ZodType}
 */
function fieldSchema(rule) {
  return z.unknown().superRefine((value, ctx) => {
    if (isMissing(value)) {
      return;
    }
    const message = rule(value);
    if (message !== null) {
      ctx.addIssue({ code: "custom", message });
    }
  });
}

const registrationEnvSchema = z.object({
  DISCORD_APPLICATION_ID: fieldSchema(snowflakeRule("DISCORD_APPLICATION_ID", "application ID")),
  DISCORD_BOT_TOKEN: fieldSchema(tokenRule),
  COURSE_GUILD_ID: fieldSchema(snowflakeRule("COURSE_GUILD_ID", "guild ID")),
});

/**
 * Read and validate the environment variables Discord command registration
 * needs. Collects every problem, so a throw names all of them at once, not
 * just the first. Unknown extra variables are ignored.
 *
 * @param {Record<string, string | undefined>} [env] Defaults to process.env.
 * @returns {{ applicationId: string, botToken: string, guildId: string }} The validated values.
 * @throws {RegistrationEnvError} When any variable is missing or malformed.
 */
export function loadRegistrationEnv(env = process.env) {
  const missing = FIELD_NAMES.filter((name) => isMissing(env[name]));

  const parsed = registrationEnvSchema.safeParse({
    DISCORD_APPLICATION_ID: env.DISCORD_APPLICATION_ID,
    DISCORD_BOT_TOKEN: env.DISCORD_BOT_TOKEN,
    COURSE_GUILD_ID: env.COURSE_GUILD_ID,
  });

  /** @type {RegistrationEnvIssue[]} */
  const issues = [];
  if (missing.length > 0) {
    const list = missing.join(", ");
    issues.push({
      field: list,
      message: `missing required environment variables: ${list}. Export the listed variables, then run the script again.`,
    });
  }
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      issues.push({ field: String(issue.path[0]), message: issue.message });
    }
  }
  if (issues.length > 0) {
    throw new RegistrationEnvError(issues);
  }

  // Every rule guarantees a string before a value can parse clean.
  return {
    applicationId: parsed.data.DISCORD_APPLICATION_ID,
    botToken: parsed.data.DISCORD_BOT_TOKEN,
    guildId: parsed.data.COURSE_GUILD_ID,
  };
}
