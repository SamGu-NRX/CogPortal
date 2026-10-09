// Contract layer for register-commands.mjs: every failure is a RegistrationError
// with a specific message and one next action, so misuse fails here instead of
// deep inside a deploy. Deliberately self-contained for now: other parts of the
// scripts hardening own register-env.mjs and discord-api.mjs, and the imports
// get wired at merge.
import { cogCommand, entryPointCommand } from "./command-payloads.mjs";

const DISCORD_API_BASE = "https://discord.com/api/v10";
const FETCH_TIMEOUT_MS = 30_000;

// Every script failure is one of these, so callers can catch it by class.
export class RegistrationError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "RegistrationError";
  }
}

// Extra guidance for the statuses whose fix is almost always the same. Kept
// short: the status and body already say what happened.
const FAILURE_HINTS = {
  401: "Discord rejected the bot token. Set DISCORD_BOT_TOKEN to a current bot token from the Discord developer portal and re-run.",
  403: "The bot does not have access to this resource. Confirm the bot is in the course guild and was installed with the applications.commands scope.",
  404: "Nothing exists at that address. Check DISCORD_APPLICATION_ID and COURSE_GUILD_ID against the Discord developer portal.",
  429: "Discord is rate limiting this application. Wait a minute, then re-run; do not retry in a tight loop.",
};

// One dedicated problem string per bad variable, so a single run reports
// everything wrong with the environment instead of failing one at a time.
// Token problems never echo the token value.
function readEnv(env) {
  const problems = [];

  const applicationId = typeof env.DISCORD_APPLICATION_ID === "string" ? env.DISCORD_APPLICATION_ID.trim() : "";
  if (!applicationId) {
    problems.push(
      "DISCORD_APPLICATION_ID is missing. Set it to the application ID from the Discord developer portal.",
    );
  } else if (!/^\d+$/.test(applicationId)) {
    problems.push(
      `DISCORD_APPLICATION_ID is malformed: "${applicationId}" is not a Discord application ID (digits only). Copy the application ID from the Discord developer portal and paste it again.`,
    );
  }

  const rawToken = typeof env.DISCORD_BOT_TOKEN === "string" ? env.DISCORD_BOT_TOKEN : "";
  const botToken = rawToken.trim();
  if (!botToken) {
    problems.push(
      "DISCORD_BOT_TOKEN is missing. Set it to a bot token from the Discord developer portal and keep it out of the repository.",
    );
  } else if (rawToken !== botToken) {
    problems.push(
      'DISCORD_BOT_TOKEN is malformed: it has leading or trailing whitespace. Paste the raw token again without surrounding spaces.',
    );
  } else if (/^bot /i.test(botToken)) {
    problems.push(
      'DISCORD_BOT_TOKEN is malformed: it already includes the "Bot " prefix. Paste the raw token only; this script adds the prefix itself.',
    );
  }

  const guildId = typeof env.COURSE_GUILD_ID === "string" ? env.COURSE_GUILD_ID.trim() : "";
  if (!guildId) {
    problems.push(
      "COURSE_GUILD_ID is missing. Set it to the course server ID: enable Developer Mode in Discord, right-click the server, choose Copy Server ID.",
    );
  } else if (!/^\d+$/.test(guildId)) {
    problems.push(
      `COURSE_GUILD_ID is malformed: "${guildId}" is not a Discord guild ID (digits only). Copy the server ID again with Developer Mode enabled.`,
    );
  }

  return { problems, applicationId, botToken, guildId };
}

// The token must never land in a message, even via an echoed response body.
function redactToken(text, botToken) {
  if (!botToken) return text;
  return text.split(botToken).join("[redacted]");
}

function describeJsonType(value) {
  if (value === null) return "null";
  switch (typeof value) {
    case "object":
      return "an object";
    case "string":
      return "a string";
    case "number":
      return "a number";
    case "boolean":
      return "a boolean";
    default:
      return `a ${typeof value}`;
  }
}

// Keeps the old message format, appends a hint when one applies.
async function failOnBadResponse(step, response, botToken) {
  if (response.ok) return;
  const detail = redactToken(await response.text(), botToken).slice(0, 500);
  const hint = FAILURE_HINTS[response.status];
  throw new RegistrationError(
    `Discord ${step} failed (${response.status}): ${detail}${hint ? `\n${hint}` : ""}`,
  );
}

export async function registerCommands({ env = process.env, fetchImpl = fetch, log = () => {} } = {}) {
  const { problems, applicationId, botToken, guildId } = readEnv(env);
  if (problems.length > 0) {
    throw new RegistrationError(
      ["The command registration environment is not usable:", ...problems.map((p) => `- ${p}`)].join("\n"),
    );
  }

  const headers = {
    Authorization: `Bot ${botToken}`,
    "Content-Type": "application/json",
  };
  const globalCommandsUrl = `${DISCORD_API_BASE}/applications/${applicationId}/commands`;

  const fetchDiscord = async (step, url, init) => {
    try {
      return await fetchImpl(url, { ...init, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    } catch (err) {
      if (err?.name === "TimeoutError" || err?.name === "AbortError") {
        throw new RegistrationError(
          `Discord ${step} timed out after 30 seconds. Check network access to discord.com, then re-run.`,
          { cause: err },
        );
      }
      throw new RegistrationError(
        `Discord ${step} could not be reached (${redactToken(String(err?.message ?? err), botToken)}). Check network access to discord.com, then re-run.`,
        { cause: err },
      );
    }
  };

  const globalResponse = await fetchDiscord("global-command lookup", globalCommandsUrl, { headers });
  await failOnBadResponse("global-command lookup", globalResponse, botToken);

  let globalCommands;
  try {
    globalCommands = await globalResponse.json();
  } catch (err) {
    throw new RegistrationError(
      "Discord global-command lookup returned a body that is not valid JSON. Re-run once; if it keeps happening, check DISCORD_APPLICATION_ID and the discord.com status page.",
      { cause: err },
    );
  }
  if (!Array.isArray(globalCommands)) {
    throw new RegistrationError(
      `Discord global-command lookup returned ${describeJsonType(globalCommands)} instead of a JSON array of commands. Writing anyway could create a duplicate Entry Point, so nothing was written. Check DISCORD_APPLICATION_ID, then re-run.`,
    );
  }

  const currentEntryPoint = globalCommands.find(
    (item) => item !== null && typeof item === "object" && item.type === 4,
  );
  if (currentEntryPoint && (typeof currentEntryPoint.id !== "string" || currentEntryPoint.id.length === 0)) {
    throw new RegistrationError(
      "Discord returned the Activity Entry Point without an id, so the script cannot tell whether to update it or create a duplicate. Nothing was written. Re-run once; if the id is still missing, check the discord.com API version used by this script.",
    );
  }

  const entryPointUrl = currentEntryPoint
    ? `${globalCommandsUrl}/${currentEntryPoint.id}`
    : globalCommandsUrl;
  const entryPointResponse = await fetchDiscord("Entry Point registration", entryPointUrl, {
    method: currentEntryPoint ? "PATCH" : "POST",
    headers,
    body: JSON.stringify(entryPointCommand),
  });
  await failOnBadResponse("Entry Point registration", entryPointResponse, botToken);

  const guildCommandsUrl = `${DISCORD_API_BASE}/applications/${applicationId}/guilds/${guildId}/commands`;
  const guildResponse = await fetchDiscord("command registration", guildCommandsUrl, {
    method: "PUT",
    headers,
    body: JSON.stringify([cogCommand]),
  });
  await failOnBadResponse("command registration", guildResponse, botToken);

  log("Registered the app-handled Activity Entry Point and /cog home surface.");
  return { entryPoint: entryPointUrl, guildCommandsReplaced: true };
}
