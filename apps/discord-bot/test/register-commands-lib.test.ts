import assert from "node:assert/strict";
import { test } from "node:test";
import { cogCommand, entryPointCommand } from "../scripts/command-payloads.mjs";
import { registerCommands, RegistrationError } from "../scripts/register-commands-lib.mjs";

const appId = "111111111111111111";
const guildId = "222222222222222222";
const token = "test-bot-token-abc123";
const apiBase = "https://discord.com/api/v10";

function validEnv(): Record<string, string> {
  return { DISCORD_APPLICATION_ID: appId, DISCORD_BOT_TOKEN: token, COURSE_GUILD_ID: guildId };
}

interface FakeInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: unknown;
}

interface RecordedCall {
  url: string;
  init: FakeInit;
}

// Structural stand-in for a Response: the lib only reads ok, status, text(), json().
interface ScriptedResponse {
  ok: boolean;
  status: number;
  text: () => Promise<string>;
  json: () => Promise<unknown>;
}

function jsonOk(body: unknown): ScriptedResponse {
  return { ok: true, status: 200, text: async () => JSON.stringify(body), json: async () => body };
}

function statusResponse(status: number, body: string): ScriptedResponse {
  return { ok: false, status, text: async () => body, json: async () => ({}) };
}

function scriptedFetch(responses: Array<ScriptedResponse | Error>, calls: Array<RecordedCall>) {
  return async (url: string, init: FakeInit): Promise<ScriptedResponse> => {
    calls.push({ url, init });
    const next = responses.shift();
    if (!next) throw new Error("fake fetch ran dry: the test scripted no response for this call");
    if (next instanceof Error) throw next;
    return next;
  };
}

async function expectRegistrationError(run: () => Promise<unknown>, check: (error: Error) => void) {
  await assert.rejects(run, (error: unknown) => {
    assert.ok(error instanceof RegistrationError, `expected a RegistrationError, got: ${String(error)}`);
    check(error as Error);
    return true;
  });
}

test("the PATCH path updates the existing Entry Point, then replaces the guild set", async () => {
  const calls: Array<RecordedCall> = [];
  const fetchImpl = scriptedFetch(
    [jsonOk([{ id: "ep-1", type: 4, name: "launch" }]), jsonOk({ id: "ep-1" }), jsonOk([])],
    calls,
  );
  const logLines: Array<string> = [];
  const result = await registerCommands({ env: validEnv(), fetchImpl, log: (line: string) => logLines.push(line) });

  assert.equal(calls.length, 3);
  const [list, entryPoint, guild] = calls;

  assert.equal(list.init.method ?? "GET", "GET");
  assert.equal(list.url, `${apiBase}/applications/${appId}/commands`);
  assert.equal(list.init.headers?.Authorization, `Bot ${token}`);
  assert.equal(list.init.headers?.["Content-Type"], "application/json");

  assert.equal(entryPoint.init.method, "PATCH");
  assert.equal(entryPoint.url, `${apiBase}/applications/${appId}/commands/ep-1`);
  assert.equal(entryPoint.init.body, JSON.stringify(entryPointCommand));
  assert.equal(entryPoint.init.headers?.Authorization, `Bot ${token}`);

  assert.equal(guild.init.method, "PUT");
  assert.equal(guild.url, `${apiBase}/applications/${appId}/guilds/${guildId}/commands`);
  assert.equal(guild.init.body, JSON.stringify([cogCommand]));

  for (const call of calls) {
    assert.ok(call.init.signal instanceof AbortSignal, "every fetch must carry a 30 second AbortSignal timeout");
  }

  assert.deepEqual(result, {
    entryPoint: `${apiBase}/applications/${appId}/commands/ep-1`,
    guildCommandsReplaced: true,
  });
  assert.deepEqual(logLines, ["Registered the app-handled Activity Entry Point and /cog home surface."]);
});

test("with no type 4 entry point the script POSTs a new one instead of guessing", async () => {
  const calls: Array<RecordedCall> = [];
  const fetchImpl = scriptedFetch([jsonOk([]), jsonOk({ id: "new-ep" }), jsonOk([])], calls);
  const result = await registerCommands({ env: validEnv(), fetchImpl });

  assert.equal(calls.length, 3);
  assert.equal(calls[1].init.method, "POST");
  assert.equal(calls[1].url, `${apiBase}/applications/${appId}/commands`);
  assert.equal(calls[1].init.body, JSON.stringify(entryPointCommand));
  assert.equal(result.entryPoint, `${apiBase}/applications/${appId}/commands`);
  assert.equal(result.guildCommandsReplaced, true);
});

test("a global command list that is not a JSON array fails loudly and writes nothing", async () => {
  for (const bad of [{ commands: [] }, "nope", null, 42]) {
    const calls: Array<RecordedCall> = [];
    const fetchImpl = scriptedFetch([jsonOk(bad)], calls);
    await expectRegistrationError(() => registerCommands({ env: validEnv(), fetchImpl }), (error) => {
      assert.match(error.message, /instead of a JSON array of commands/);
      assert.match(error.message, /Check DISCORD_APPLICATION_ID/);
    });
    assert.equal(calls.length, 1, "a non-array list must stop before any PATCH, POST, or PUT");
  }
});

test("an Entry Point match without a string id fails loudly and writes nothing", async () => {
  for (const list of [[{ type: 4, name: "launch" }], [{ id: 1234, type: 4 }], [{ id: "", type: 4 }]]) {
    const calls: Array<RecordedCall> = [];
    const fetchImpl = scriptedFetch([jsonOk(list)], calls);
    await expectRegistrationError(() => registerCommands({ env: validEnv(), fetchImpl }), (error) => {
      assert.match(error.message, /Entry Point without an id/);
      assert.match(error.message, /Nothing was written/);
    });
    assert.equal(calls.length, 1, "an unidentifiable Entry Point must stop before any PATCH, POST, or PUT");
  }
});

test("every non-ok response keeps the Discord failure format and adds the right hint", async () => {
  const hintSignatures: Array<[number, string | null]> = [
    [401, "Discord rejected the bot token"],
    [403, "applications.commands scope"],
    [404, "Check DISCORD_APPLICATION_ID and COURSE_GUILD_ID"],
    [429, "rate limiting this application"],
    [500, null],
  ];
  for (const [status, hint] of hintSignatures) {
    const calls: Array<RecordedCall> = [];
    const fetchImpl = scriptedFetch([statusResponse(status, "discord says no")], calls);
    await expectRegistrationError(() => registerCommands({ env: validEnv(), fetchImpl }), (error) => {
      assert.ok(
        error.message.startsWith(`Discord global-command lookup failed (${status}): discord says no`),
        `wrong message for ${status}: ${error.message}`,
      );
      if (hint) {
        assert.ok(error.message.includes(hint), `missing hint for ${status}: ${error.message}`);
      } else {
        assert.ok(!error.message.includes("\n"), `status ${status} should have no hint, got: ${error.message}`);
      }
    });
    assert.equal(calls.length, 1);
  }
});

test("Entry Point and guild steps report their own step name on failure", async () => {
  const entryCalls: Array<RecordedCall> = [];
  const entryFetch = scriptedFetch([jsonOk([]), statusResponse(403, "forbidden")], entryCalls);
  await expectRegistrationError(
    () => registerCommands({ env: validEnv(), fetchImpl: entryFetch }),
    (error) => {
      assert.ok(error.message.startsWith("Discord Entry Point registration failed (403): forbidden"));
      assert.match(error.message, /applications\.commands scope/);
    },
  );
  assert.equal(entryCalls.length, 2);

  const guildCalls: Array<RecordedCall> = [];
  const guildFetch = scriptedFetch(
    [jsonOk([{ id: "ep-1", type: 4 }]), jsonOk({}), statusResponse(429, "slow down")],
    guildCalls,
  );
  await expectRegistrationError(
    () => registerCommands({ env: validEnv(), fetchImpl: guildFetch }),
    (error) => {
      assert.ok(error.message.startsWith("Discord command registration failed (429): slow down"));
      assert.match(error.message, /rate limiting this application/);
    },
  );
  assert.equal(guildCalls.length, 3);
});

test("a failure body is cut to 500 characters", async () => {
  const body = "x".repeat(600) + "TAIL-MARKER";
  const fetchImpl = scriptedFetch([statusResponse(500, body)], []);
  await expectRegistrationError(() => registerCommands({ env: validEnv(), fetchImpl }), (error) => {
    assert.ok(error.message.includes("x".repeat(500)));
    assert.ok(!error.message.includes("TAIL-MARKER"), "body beyond 500 characters must not reach the message");
  });
});

test("no message ever contains the bot token, even from an echoed response body", async () => {
  const leakedBody = `{"token": "${token}", "message": "bad request"}`;
  const fetchImpl = scriptedFetch([statusResponse(401, leakedBody)], []);
  await expectRegistrationError(() => registerCommands({ env: validEnv(), fetchImpl }), (error) => {
    assert.ok(!error.message.includes(token), "the failure message leaked the bot token");
    assert.match(error.message, /\[redacted\]/);
  });
});

test("even a thrown network error cannot leak the token into a message", async () => {
  const leak = new Error(`connect ECONNREFUSED; token was ${token}`);
  const fetchImpl = scriptedFetch([leak], []);
  await expectRegistrationError(() => registerCommands({ env: validEnv(), fetchImpl }), (error) => {
    assert.ok(!error.message.includes(token), "the network error message leaked the bot token");
    assert.match(error.message, /\[redacted\]/);
  });
});

test("a missing variable and a malformed one are reported together, each with its own message", async () => {
  const calls: Array<RecordedCall> = [];
  const fetchImpl = scriptedFetch([], calls);
  const env = { DISCORD_BOT_TOKEN: "Bot test-bot-token-abc123", COURSE_GUILD_ID: guildId };
  await expectRegistrationError(() => registerCommands({ env, fetchImpl }), (error) => {
    assert.match(error.message, /DISCORD_APPLICATION_ID is missing/);
    assert.match(error.message, /DISCORD_BOT_TOKEN is malformed/);
    assert.match(error.message, /"Bot " prefix/);
    assert.ok(!error.message.includes("Bot test-bot-token-abc123"), "the env message echoed the token");
  });
  assert.equal(calls.length, 0, "a bad environment must fail before any network call");
});

test("all three variables missing are reported together in one run", async () => {
  const calls: Array<RecordedCall> = [];
  const fetchImpl = scriptedFetch([], calls);
  await expectRegistrationError(() => registerCommands({ env: {}, fetchImpl }), (error) => {
    assert.match(error.message, /DISCORD_APPLICATION_ID is missing/);
    assert.match(error.message, /DISCORD_BOT_TOKEN is missing/);
    assert.match(error.message, /COURSE_GUILD_ID is missing/);
  });
  assert.equal(calls.length, 0);
});

test("a wedged network times out after 30 seconds instead of hanging the deploy", async () => {
  const timeoutError = new Error("The operation was aborted due to timeout");
  timeoutError.name = "TimeoutError";
  const fetchImpl = scriptedFetch([timeoutError], []);
  await expectRegistrationError(() => registerCommands({ env: validEnv(), fetchImpl }), (error) => {
    assert.match(error.message, /global-command lookup timed out after 30 seconds/);
    assert.match(error.message, /Check network access to discord\.com/);
    assert.equal((error as Error & { cause?: unknown }).cause, timeoutError);
  });
});

test("a network failure before any response names the step and keeps the cause", async () => {
  const boom = new TypeError("fetch failed");
  const fetchImpl = scriptedFetch([boom], []);
  await expectRegistrationError(() => registerCommands({ env: validEnv(), fetchImpl }), (error) => {
    assert.match(error.message, /global-command lookup could not be reached \(fetch failed\)/);
    assert.equal((error as Error & { cause?: unknown }).cause, boom);
  });
});
