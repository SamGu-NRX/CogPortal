import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { ApiRequestError, api } from "../src/lib/api.ts";

/**
 * Contract tests for the browser API client (src/lib/api.ts).
 * Runs under plain node (tsx): fetch is stubbed on globalThis and restored
 * after each test via t.after.
 */

type FetchCalls = Array<{ url: string; init?: RequestInit }>;

function stubFetch(t: TestContext, impl: (url: string, init?: RequestInit) => Promise<Response>): {
  calls: FetchCalls;
} {
  const original = globalThis.fetch;
  const calls: FetchCalls = [];
  globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    calls.push({ url, init });
    return impl(url, init);
  };
  t.after(() => {
    globalThis.fetch = original;
  });
  return { calls };
}

function jsonResponse(status: number, body: string): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "application/json" },
  });
}

const authConfig = {
  githubConfigured: true,
  devAuthEnabled: true,
  onboardingDevToolsEnabled: false,
  appSlug: "cogworks-bwsi",
  templateRepo: "CogWorksBWSI/week2-vision-capstone",
  executionProvider: "fixture",
};

/** Logout response: every entity is nullable once signed out. */
const loggedOutSession = {
  user: null,
  cohort: null,
  team: null,
  auth: authConfig,
};

test("api.logout sends POST and parses the session the worker returns", async (t) => {
  const { calls } = stubFetch(t, () =>
    jsonResponse(200, JSON.stringify(loggedOutSession)),
  );
  const session = await api.logout();
  assert.deepEqual(session, loggedOutSession);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "/api/session/logout");
  assert.equal(calls[0].init?.method, "POST");
});

test("api.logout rejects a 200 body that is not a session", async (t) => {
  stubFetch(t, () => jsonResponse(200, JSON.stringify({ loggedOut: true })));
  await assert.rejects(
    api.logout(),
    (error: unknown) => {
      assert.ok(error instanceof ApiRequestError);
      assert.equal(error.code, "unknown");
      assert.equal(error.status, 200);
      assert.match(error.message, /POST \/api\/session\/logout/);
      return true;
    },
  );
});

test("api.selectResult sends PUT with the runId and parses the ok ack", async (t) => {
  const { calls } = stubFetch(t, () =>
    jsonResponse(200, JSON.stringify({ ok: true })),
  );
  const result = await api.selectResult("run-1");
  assert.deepEqual(result, { ok: true });
  assert.equal(calls[0].url, "/api/leaderboard-selection");
  assert.equal(calls[0].init?.method, "PUT");
  assert.deepEqual(JSON.parse(String(calls[0].init?.body)), { runId: "run-1" });
});

test("api.selectResult rejects a 200 body without ok true", async (t) => {
  stubFetch(t, () => jsonResponse(200, JSON.stringify({ ok: false })));
  await assert.rejects(
    api.selectResult("run-1"),
    (error: unknown) => {
      assert.ok(error instanceof ApiRequestError);
      assert.equal(error.code, "unknown");
      assert.equal(error.status, 200);
      assert.match(error.message, /PUT \/api\/leaderboard-selection/);
      return true;
    },
  );
});

test("a 200 with an unexpected body throws ApiRequestError, not a raw ZodError", async (t) => {
  stubFetch(t, () => jsonResponse(200, JSON.stringify({ unexpected: true })));
  await assert.rejects(
    api.session(),
    (error: unknown) => {
      assert.ok(error instanceof ApiRequestError);
      assert.equal(error.name, "ApiRequestError");
      assert.equal(error.code, "unknown");
      assert.equal(error.status, 200);
      assert.match(error.message, /GET \/api\/session/);
      assert.match(error.message, /"user"/);
      return true;
    },
  );
});

test("a 200 with a non-JSON body throws ApiRequestError", async (t) => {
  stubFetch(t, () => new Response("<html>oops</html>", { status: 200 }));
  await assert.rejects(
    api.session(),
    (error: unknown) => {
      assert.ok(error instanceof ApiRequestError);
      assert.equal(error.code, "unknown");
      assert.equal(error.status, 200);
      assert.match(error.message, /GET \/api\/session/);
      assert.match(error.message, /not valid JSON/);
      return true;
    },
  );
});

test("a well-formed ApiError body keeps its code, message, and status", async (t) => {
  stubFetch(t, () =>
    jsonResponse(
      503,
      JSON.stringify({
        error: {
          code: "provider_unconfigured",
          message: "Development user could not be loaded.",
        },
      }),
    ),
  );
  await assert.rejects(
    api.session(),
    (error: unknown) => {
      assert.ok(error instanceof ApiRequestError);
      assert.equal(error.code, "provider_unconfigured");
      assert.equal(error.message, "Development user could not be loaded.");
      assert.equal(error.status, 503);
      return true;
    },
  );
});

test("a non-JSON error body falls back to the generic message", async (t) => {
  stubFetch(t, () => new Response("Service Unavailable", { status: 500 }));
  await assert.rejects(
    api.session(),
    (error: unknown) => {
      assert.ok(error instanceof ApiRequestError);
      assert.equal(error.code, "unknown");
      assert.equal(error.message, "The portal returned an unexpected error (500).");
      assert.equal(error.status, 500);
      return true;
    },
  );
});

test("a malformed ApiError body falls back to the generic message", async (t) => {
  stubFetch(t, () =>
    jsonResponse(502, JSON.stringify({ error: { code: "not_a_real_code" } })),
  );
  await assert.rejects(
    api.session(),
    (error: unknown) => {
      assert.ok(error instanceof ApiRequestError);
      assert.equal(error.code, "unknown");
      assert.equal(error.message, "The portal returned an unexpected error (502).");
      assert.equal(error.status, 502);
      return true;
    },
  );
});

test("a fetch rejection becomes a network error with status 0", async (t) => {
  stubFetch(t, () => Promise.reject(new TypeError("fetch failed")));
  await assert.rejects(
    api.session(),
    (error: unknown) => {
      assert.ok(error instanceof ApiRequestError);
      assert.equal(error.code, "network");
      assert.equal(error.status, 0);
      assert.equal(
        error.message,
        "Could not reach the portal. Check your connection and try again.",
      );
      return true;
    },
  );
});

test("path ids are percent-encoded and query values survive encoding", async (t) => {
  const { calls } = stubFetch(t, (url) => {
    if (url.startsWith("/api/runs?")) {
      return jsonResponse(200, "[]");
    }
    return jsonResponse(200, JSON.stringify({ runId: "run-9" }));
  });
  const promoted = await api.promote("a/b c");
  assert.deepEqual(promoted, { runId: "run-9" });
  assert.equal(calls[0].url, "/api/runs/a%2Fb%20c/promote");
  assert.equal(calls[0].init?.method, "POST");

  const runs = await api.runs("bench mark");
  assert.deepEqual(runs, []);
  assert.equal(calls[1].url, "/api/runs?benchmark=bench%20mark");
});
