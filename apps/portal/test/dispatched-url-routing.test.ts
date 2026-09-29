import assert from "node:assert/strict";
import test from "node:test";
import { registerHooks } from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Does a URL we hand to another machine still reach its handler?
 *
 * Two files have to agree for a callback to arrive, and they never import each
 * other. `execution/runner.ts` writes the path as a template literal, and
 * `index.ts` mounts the API router under a prefix. Editing either one alone
 * moves the door without moving the address.
 *
 * The failure is silent, which is why it needs a test rather than a code
 * review. `wrangler.jsonc` configures the assets binding with
 * `not_found_handling: "single-page-application"`, and the outer `notFound` in
 * `index.ts` hands any non-`/api` path to that binding. So a request to
 * `/internal/v1/runner/events` (the mount prefix dropped) gets the SPA shell
 * with **status 200**. Modal's `_post_event` retries only 429 and 5xx, so it
 * reads 200 as delivery and posts a whole evaluation into the void. The run
 * looks like a hang until the stale reaper closes it an hour later, and the
 * sandbox time is already spent.
 *
 * This guard is behavioural. It builds the URL by calling the same dispatcher
 * code that Modal is given, then routes a real POST at it through the real
 * top-level Worker app, so the mount and the SPA catch-all are both exercised.
 * Comparing two pasted strings would put a third copy of the coincidence in
 * this file and prove nothing about routing.
 */

/**
 * `worker/index.ts` re-exports two classes that extend `cloudflare:workers`
 * base types (`rpc.ts`, `realtime/run-surface-hub.ts`). Node's ESM loader
 * refuses that scheme, so importing the app fails before any test runs. Both
 * are used only as `extends` bases and are never constructed on the request
 * path, so an empty stand-in is enough to load the module.
 *
 * `registerHooks` is synchronous and in-process (Node 22.15+), so this needs
 * no loader flag, config file, or new dependency. It must run before the
 * dynamic imports below, which is why those are not static imports.
 */
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "cloudflare:workers") {
      return {
        url: "data:text/javascript,export class WorkerEntrypoint{};export class DurableObject{};",
        shortCircuit: true,
        format: "module",
      };
    }
    return nextResolve(specifier, context);
  },
});

const { default: worker } = await import("../worker/index.ts");
const { buildRunJob } = await import("../worker/execution/runner.ts");

const PORTAL_ORIGIN = "https://portal.example.com";

interface Probe {
  status: number;
  code: string | undefined;
  message: string | undefined;
  servedByAssets: boolean;
}

/**
 * Route one request through the real Worker and report where it landed.
 *
 * `servedByAssets` is the signal that matters most: the SPA fallthrough is the
 * only branch that answers with a success status for a path the API never saw,
 * so a status check alone cannot tell "handled" from "lost".
 */
async function routeThroughWorker(
  url: string,
  method = "POST",
  headers: Record<string, string> = {},
): Promise<Probe> {
  let servedByAssets = false;
  const env = {
    ENVIRONMENT: "development",
    DEV_AUTH: "disabled",
    EXECUTION_PROVIDER: "modal",
    PUBLIC_ORIGIN: PORTAL_ORIGIN,
    RUNNER_SIGNING_SECRET: "test-signing-secret",
    ASSETS: {
      fetch: () => {
        servedByAssets = true;
        return Promise.resolve(new Response("<!doctype html>", { status: 200 }));
      },
    },
  };
  const response = await worker.fetch(
    new Request(url, { method, headers, ...(method === "POST" ? { body: "{}" } : {}) }),
    env as never,
    {} as never,
  );
  const body = (await response.json().catch(() => ({}))) as {
    error?: { code?: string; message?: string };
  };
  return {
    status: response.status,
    code: body.error?.code,
    message: body.error?.message,
    servedByAssets,
  };
}

/** A run, team, and benchmark just complete enough to satisfy `RunJobV1Schema`. */
function dispatcherCallbackUrl(origin = PORTAL_ORIGIN): string {
  const job = buildRunJob(
    { PUBLIC_ORIGIN: origin, EXECUTION_PROVIDER: "modal" } as never,
    {
      id: "run_test",
      mode: "practice",
      preparedArtifactId: null,
      repositoryId: 1,
      sha: "a".repeat(40),
    } as never,
    {
      repoOwner: "course",
      repoName: "team-fork",
      repoFullName: "course/team-fork",
      repoId: 1,
    } as never,
    {
      id: "audio-identification",
      version: 1,
      contractVersion: "week1-v1",
      pluginVersion: "1.0.0",
      datasetVersion: "eval-v1",
      scorerVersion: "1.0.0",
      sandboxContract: 1,
    } as never,
  );
  return job.callback.url;
}

test("the callback URL Modal is given reaches the runner-events handler", async () => {
  const job = buildRunJob(
    { PUBLIC_ORIGIN: PORTAL_ORIGIN, EXECUTION_PROVIDER: "modal" } as never,
    { id: "run_test", mode: "practice", preparedArtifactId: null, repositoryId: 1, sha: "a".repeat(40) } as never,
    { repoOwner: "course", repoName: "team-fork", repoFullName: "course/team-fork", repoId: 1 } as never,
    {
      id: "audio-identification",
      version: 1,
      contractVersion: "week1-v1",
      pluginVersion: "1.0.0",
      datasetVersion: "eval-v1",
      scorerVersion: "1.0.0",
      sandboxContract: 1,
    } as never,
  );

  // The key id travels in the same job object as the URL, and the handler
  // checks it before the signature. Sending the dispatcher's own value proves
  // both halves of the job's callback block agree with this handler, and it is
  // what lets the request reach the signature check below.
  const probe = await routeThroughWorker(job.callback.url, "POST", {
    "X-Cogworks-Key-Id": job.callback.keyId,
  });

  assert.equal(probe.servedByAssets, false, "the callback URL fell through to the SPA assets");
  assert.equal(probe.status, 401);
  assert.equal(probe.code, "unauthorized");
  // `verifyRunnerEvent` runs its checks in a fixed order, and this message is
  // the third one. Asserting it, rather than 401 alone, is what makes this a
  // claim about *this* handler: `requireUser` also answers 401 `unauthorized`,
  // so a future refactor that put the internal route behind session auth would
  // pass a status-and-code check while the callback no longer arrived. Reaching
  // check three also proves the key id the dispatcher writes into the job is
  // the one this handler accepts, which is the same two-file agreement in
  // miniature. Nothing here touches the database; verification returns first.
  assert.equal(probe.message, "Runner signature is missing.");
}, { concurrency: false });

test("a broken mount prefix or route string stops reaching the handler", async () => {
  // The guard above is only worth having if it fails when the wiring breaks.
  // These are the two ways to break it, run rather than reasoned about.
  const correct = dispatcherCallbackUrl();

  // 1. The mount prefix in `index.ts` changes and the dispatcher literal does
  //    not. This is the silent one: 200, which `res.ok` and "not 404" both
  //    accept. If this ever stops being 200, the SPA fallthrough changed and
  //    this guard's premise is worth rereading.
  const droppedPrefix = await routeThroughWorker(correct.replace("/api/internal", "/internal"));
  assert.equal(droppedPrefix.servedByAssets, true);
  assert.equal(droppedPrefix.status, 200);
  assert.notEqual(droppedPrefix.status, 401);

  // 2. The route string in `runner-events.ts` loses a segment. This one stays
  //    under `/api`, so the API router's own notFound answers.
  const brokenRoute = await routeThroughWorker(correct.replace("/v1/runner/events", "/runner/events"));
  assert.equal(brokenRoute.servedByAssets, false);
  assert.equal(brokenRoute.status, 404);
  assert.equal(brokenRoute.code, "not_found");

  // 3. A trailing slash on PUBLIC_ORIGIN must not double the separator.
  assert.equal(dispatcherCallbackUrl(`${PORTAL_ORIGIN}/`), correct);
}, { concurrency: false });

/**
 * The same shape, one language over.
 *
 * `python/cogbench/src/cogbench/client.py` writes eight full paths as literals
 * against handlers registered without the `/api` prefix in the same four route
 * files the Worker mounts. Two of them carry the load: `send_local_run_event`
 * and `send_local_run_event_batch` are caught in `cli.py` and downgraded to one
 * stderr warning by design, so a student's run finishes, prints its report, and
 * the portal simply never learns. That is the callback failure again. The other
 * six raise into `main`'s handler and end the command visibly, and they are
 * swept here only because reading every literal out of the file is simpler and
 * more honest than maintaining a hand-picked list of two.
 *
 * Read from disk rather than restated, so this file cannot drift from the CLI
 * and quietly agree with itself.
 */
test("every path the CLI posts to reaches a route that exists", async () => {
  const clientSource = readFileSync(
    fileURLToPath(new URL("../../../python/cogbench/src/cogbench/client.py", import.meta.url)),
    "utf8",
  );

  const callSites = clientSource.match(/(?<!def )request_json\(/g) ?? [];
  const paths = [...clientSource.matchAll(/(?<!def )request_json\(\s*portal,\s*"([^"]+)"/g)].map(
    (match) => match[1],
  );

  // Without this the sweep passes vacuously if the extraction stops matching.
  // Comparing against the call-site count rather than a hardcoded number means
  // a ninth endpoint is covered automatically, and a call whose path the regex
  // cannot see fails loudly instead of going unchecked.
  assert.ok(callSites.length > 0, "found no request_json call sites to check");
  assert.equal(paths.length, callSites.length, "some request_json path could not be read");

  // A route reached with no database bound logs one line and answers 500, which
  // is proof it routed and not a fact under test. The response is the evidence.
  const realConsoleError = console.error;
  console.error = () => {};
  try {
    for (const path of paths) {
      // `{}` is a Python format placeholder for a session id.
      const method = path.endsWith("/status") ? "GET" : "POST";
      const probe = await routeThroughWorker(
        `${PORTAL_ORIGIN}${path.replace("{}", "localrun_test")}`,
        method,
      );
      // Each of these has its own auth and parse order, so the rejection they
      // return differs. What they share is the only thing this test claims: the
      // request reached the API router, at a route that is registered.
      assert.equal(probe.servedByAssets, false, `${path} fell through to the SPA assets`);
      assert.notEqual(probe.code, "not_found", `${path} has no registered route`);
    }
  } finally {
    console.error = realConsoleError;
  }
}, { concurrency: false });
