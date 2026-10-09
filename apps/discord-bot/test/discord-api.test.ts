import assert from "node:assert/strict";
import { test } from "node:test";
// discord-api.mjs is plain JavaScript; this part may not add the sibling
// .d.mts declaration the other script imports use, so the import is untyped.
// @ts-ignore
import { DiscordApiError, discordFetchJson, parseApplicationCommands } from "../scripts/discord-api.mjs";

/** The slice of the real Response surface the module reads. */
type FakeResponse = { ok: boolean; status: number; text: () => Promise<string> };
type FetchInit = { method?: string; signal?: AbortSignal; headers?: Record<string, string> };
type FetchImpl = (url: string, init: FetchInit) => Promise<unknown>;
type DiscordApiErrorShape = Error & {
  status?: number;
  method?: string;
  url?: string;
  body?: string;
};

const commandsUrl = "https://discord.com/api/v10/applications/123/commands";

function fakeResponse(status: number, body: string): FakeResponse {
  return { ok: status >= 200 && status < 300, status, text: async () => body };
}

function fetchReturning(status: number, body: string): FetchImpl {
  return async () => fakeResponse(status, body);
}

function fetchRejecting(error: unknown): FetchImpl {
  return async () => {
    throw error;
  };
}

function isDiscordApiError(error: unknown, check: (apiError: DiscordApiErrorShape) => void): boolean {
  assert.ok(error instanceof DiscordApiError, `expected DiscordApiError, got: ${String(error)}`);
  check(error as DiscordApiErrorShape);
  return true;
}

test("discordFetchJson returns the parsed JSON body and passes a timeout signal", async () => {
  const value = [{ id: "1", name: "cog" }];
  const observed: Array<{ url: string; init: FetchInit }> = [];
  const fetchImpl: FetchImpl = async (url, init) => {
    observed.push({ url, init });
    return fakeResponse(200, JSON.stringify(value));
  };

  const result = await discordFetchJson(commandsUrl, {}, { fetchImpl });

  assert.deepEqual(result, value);
  assert.equal(observed[0]?.url, commandsUrl);
  const signal = observed[0]?.init.signal;
  assert.ok(signal instanceof AbortSignal, "fetch must receive a signal");
  assert.equal(signal?.aborted, false);
});

test("discordFetchJson combines the caller signal with the timeout signal", async () => {
  const controller = new AbortController();
  const observed: FetchInit[] = [];
  const fetchImpl: FetchImpl = async (_url, init) => {
    observed.push(init);
    return fakeResponse(200, "{}");
  };

  await discordFetchJson(commandsUrl, { signal: controller.signal }, { fetchImpl });

  const signal = observed[0]?.signal;
  assert.ok(signal instanceof AbortSignal);
  assert.notEqual(signal, controller.signal, "the caller signal must be wrapped, not passed through");
  assert.equal(signal?.aborted, false);
  controller.abort();
  assert.equal(signal?.aborted, true, "a caller abort must reach the combined signal");
});

test("a 401 with an HTML body names status, method, url, hint and body slice without the token", async () => {
  const html = "<!DOCTYPE html><html><body>502 Bad Gateway from proxy</body></html>";
  await assert.rejects(
    discordFetchJson(
      commandsUrl,
      { method: "POST", headers: { Authorization: "Bot super-secret-token-42" } },
      { fetchImpl: fetchReturning(401, html) },
    ),
    (error: unknown) =>
      isDiscordApiError(error, (apiError) => {
        assert.equal(
          apiError.message,
          `Discord API call failed (401 POST ${commandsUrl}): ${html} (check DISCORD_BOT_TOKEN)`,
        );
        assert.equal(apiError.status, 401);
        assert.equal(apiError.method, "POST");
        assert.equal(apiError.url, commandsUrl);
        assert.equal(apiError.body, html);
        const serialized = [apiError.message, apiError.status, apiError.method, apiError.url, apiError.body]
          .map(String)
          .join("|");
        assert.ok(!serialized.includes("super-secret-token-42"), "the Authorization value must never be echoed");
      }),
  );
});

test("a long error body is sliced to 500 characters and unknown statuses get no hint", async () => {
  const longBody = "x".repeat(1200);
  await assert.rejects(
    discordFetchJson(commandsUrl, {}, { fetchImpl: fetchReturning(500, longBody) }),
    (error: unknown) =>
      isDiscordApiError(error, (apiError) => {
        assert.equal(apiError.body?.length, 500);
        assert.equal(
          apiError.message,
          `Discord API call failed (500 GET ${commandsUrl}): ${"x".repeat(500)}`,
        );
      }),
  );
});

test("known statuses carry a next-action hint", async () => {
  const hints: Array<[number, string]> = [
    [403, "check the application scopes and permissions"],
    [404, "check the application and guild IDs"],
    [429, "rate limited, retry later"],
  ];
  for (const [status, hint] of hints) {
    await assert.rejects(
      discordFetchJson(commandsUrl, {}, { fetchImpl: fetchReturning(status, "{}") }),
      (error: unknown) =>
        isDiscordApiError(error, (apiError) => {
          assert.equal(
            apiError.message,
            `Discord API call failed (${status} GET ${commandsUrl}): {} (${hint})`,
          );
          assert.equal(apiError.status, status);
        }),
    );
  }
});

test("an ok response with a non-JSON body produces the non-JSON error", async () => {
  const html = "<html>maintenance page</html>";
  await assert.rejects(
    discordFetchJson(commandsUrl, {}, { fetchImpl: fetchReturning(200, html) }),
    (error: unknown) =>
      isDiscordApiError(error, (apiError) => {
        assert.equal(apiError.message, `Discord API returned a non-JSON response (200): ${html}`);
        assert.equal(apiError.status, 200);
        assert.equal(apiError.method, "GET");
        assert.equal(apiError.url, commandsUrl);
        assert.equal(apiError.body, html);
      }),
  );
});

test("a fetch that times out produces the timeout error", async () => {
  const fetchImpl: FetchImpl = (_url, init) =>
    new Promise((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
    });

  await assert.rejects(
    discordFetchJson(commandsUrl, {}, { fetchImpl, timeoutMs: 20 }),
    (error: unknown) =>
      isDiscordApiError(error, (apiError) => {
        assert.equal(
          apiError.message,
          `Discord API call timed out after 20ms (GET ${commandsUrl}). If this endpoint is slow, pass a larger timeoutMs.`,
        );
        assert.equal(apiError.method, "GET");
        assert.equal(apiError.url, commandsUrl);
      }),
  );
});

test("a caller abort produces an error naming the underlying cause", async () => {
  const controller = new AbortController();
  const fetchImpl: FetchImpl = (_url, init) =>
    new Promise((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
    });

  const pending = discordFetchJson(commandsUrl, { signal: controller.signal }, { fetchImpl });
  controller.abort(new DOMException("student closed the tab", "AbortError"));

  await assert.rejects(pending, (error: unknown) =>
    isDiscordApiError(error, (apiError) => {
      assert.equal(apiError.message, `Discord API call was aborted (GET ${commandsUrl}): student closed the tab`);
    }),
  );
});

test("a network failure names the underlying cause", async () => {
  await assert.rejects(
    discordFetchJson(commandsUrl, {}, { fetchImpl: fetchRejecting(new TypeError("fetch failed")) }),
    (error: unknown) =>
      isDiscordApiError(error, (apiError) => {
        assert.equal(
          apiError.message,
          `Discord API call failed before a response arrived (GET ${commandsUrl}): fetch failed. Check the network connection and retry.`,
        );
      }),
  );
});

test("parseApplicationCommands passes a valid command list and keeps unknown fields", () => {
  const commands = [
    { id: "123456789012345678", type: 4, name: "launch", handler: 1, integration_types: [0, 1] },
    { id: "233456789012345678" },
  ];

  assert.deepEqual(parseApplicationCommands(commands), commands);
});

test("parseApplicationCommands tolerates a string type and a number name", () => {
  const commands = [{ id: "1", type: "APP_HANDLED", name: 7, random: true }];

  assert.deepEqual(parseApplicationCommands(commands), commands);
});

test("parseApplicationCommands rejects a non-array", () => {
  assert.throws(
    () => parseApplicationCommands({ id: "123" }),
    (error: unknown) =>
      isDiscordApiError(error, (apiError) => {
        assert.equal(
          apiError.message,
          "Discord command list response has an unexpected shape: (list): Invalid input: expected array, received object",
        );
      }),
  );
});

test("parseApplicationCommands rejects an element without a string id", () => {
  assert.throws(
    () => parseApplicationCommands([{ id: 123 }, { id: "abc" }]),
    (error: unknown) =>
      isDiscordApiError(error, (apiError) => {
        assert.match(
          apiError.message ?? "",
          /^Discord command list response has an unexpected shape: 0\.id: Invalid input: expected string, received number; 1\.id: must be a digit string/,
        );
      }),
  );
});
