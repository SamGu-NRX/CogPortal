import assert from "node:assert/strict";
import test from "node:test";
import * as React from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Route, Routes } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Window } from "happy-dom";
import type { Session } from "@cogworks/contracts/schema";
import { RequireStage } from "../src/App.tsx";
import { RestoreGate, sameAccount } from "../src/components/RestoreGate.tsx";
import { Shell } from "../src/components/Shell.tsx";
import { SetupPage } from "../src/routes/SetupPage.tsx";

// A document that comes back from the back/forward cache or a background tab
// may find a different account signed in, set by another tab. The setup
// page's commands carry tokens signed for the account that loaded them, so
// nothing from that account may be visible or copyable until the gate has
// read the session again. The switch happens on the fake server only, never
// through this document's own sign-in hooks.

type Teams = "shared" | "own";

const teamIdFor = (login: string, teams: Teams) => teams === "shared" ? "team_shared" : `team_${login}`;
const teamNameFor = (login: string, teams: Teams) => teams === "shared" ? "Shared" : `Team of ${login}`;

function sessionFor(login: string | null, teams: Teams = "shared"): Session {
  return {
    user: login
      ? { login, name: `Name of ${login}`, avatarUrl: null, platformRole: "student", isOwner: false, isTa: false }
      : null,
    cohort: login ? { slug: "bwsi-2026", name: "BWSI CogWorks 2026" } : null,
    // A shared team by default: the tokens differ by account regardless.
    team: login
      ? { id: teamIdFor(login, teams), name: teamNameFor(login, teams), description: null, provenance: "live", repo: null }
      : null,
    auth: {
      githubConfigured: false,
      devAuthEnabled: true,
      onboardingDevToolsEnabled: false,
      appSlug: null,
      templateRepo: null,
      executionProvider: "fixture",
    },
  } as Session;
}

const tokenFor = (login: string) => `signed-clone-token-for-${login}`;

const teamDetailFor = (login: string, teams: Teams) => ({
  id: teamIdFor(login, teams),
  name: teamNameFor(login, teams),
  description: null,
  provenance: "live",
  repo: {
    owner: "cogworks-demo",
    name: "face-finder",
    fullName: "cogworks-demo/face-finder",
    url: "https://github.com/cogworks-demo/face-finder",
    defaultBranch: "main",
  },
  members: [],
  tas: [],
  isAdmin: false,
});

const BENCHMARK = {
  id: "vision-recognition",
  version: 1,
  contractVersion: "cogworks.submissions.v1",
  entryPointName: "vision-recognition",
  title: "Face recognition",
  module: "vision",
  summary: "Recognize faces.",
  active: true,
  pluginVersion: "1",
  datasetVersion: "1",
  scorerVersion: "1",
  runtimeVersion: "1",
};

type Held = { as: string | null; release: () => void };

/** A stand-in for the worker. Every answer is for the account whose cookie
 *  the request carried when it was sent. */
function portal(teams: Teams) {
  let signedIn: string | null = null;
  const sessionRequests: (string | null)[] = [];
  let sessionMode: "answer" | "hold" | "fail" = "answer";
  const heldSessions: Held[] = [];
  let holdSetup = false;
  const heldSetup: Held[] = [];

  const fetch = async (input: string) => {
    const url = new URL(input, "https://portal.example");
    const as = signedIn;
    if (url.pathname === "/api/session") {
      sessionRequests.push(as);
      if (sessionMode === "fail") throw new TypeError("Failed to fetch");
      if (sessionMode === "hold") {
        return new Promise<Response>((resolve) =>
          heldSessions.push({ as, release: () => resolve(Response.json(sessionFor(as, teams))) }));
      }
      return Response.json(sessionFor(as, teams));
    }
    if (as === null) {
      return Response.json({ error: { code: "unauthorized", message: "Sign in." } }, { status: 401 });
    }
    if (url.pathname === "/api/team") return Response.json(teamDetailFor(as, teams));
    if (url.pathname === "/api/benchmarks") return Response.json([BENCHMARK]);
    if (url.pathname === "/api/v1/connections") {
      return Response.json({ github: null, discord: null, cliDevices: [] });
    }
    if (url.pathname === "/api/v1/setup/state") {
      const answer = () => Response.json({
        verified: [],
        verifiedByBenchmark: {},
        checked: [],
        checkedByBenchmark: {},
        tokens: { clone: tokenFor(as) },
      });
      if (!holdSetup) return answer();
      return new Promise<Response>((resolve) => heldSetup.push({ as, release: () => resolve(answer()) }));
    }
    throw new Error(`unexpected request ${url.pathname}`);
  };

  const release = (queue: Held[], as: string) => {
    const index = queue.findIndex((entry) => entry.as === as);
    assert.notEqual(index, -1, `no request was sent as ${as}`);
    queue.splice(index, 1)[0].release();
  };

  return {
    fetch,
    sessionRequests,
    signInDirectly: (login: string) => { signedIn = login; },
    session: (mode: "answer" | "hold" | "fail") => { sessionMode = mode; },
    releaseSession: (as: string) => release(heldSessions, as),
    holdSetupState: (value: boolean) => { holdSetup = value; },
    releaseSetupState: (as: string) => release(heldSetup, as),
  };
}

type Return = "bfcache" | "visibility";

async function harness(t: test.TestContext, teams: Teams = "shared") {
  const window = new Window({ url: "https://portal.example/setup" });
  const server = portal(teams);
  const globals = {
    window, document: window.document, navigator: window.navigator,
    HTMLElement: window.HTMLElement, Element: window.Element, SVGElement: window.SVGElement,
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
    React, IS_REACT_ACT_ENVIRONMENT: true,
    fetch: server.fetch,
  };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  let visibility: "visible" | "hidden" = "visible";
  Object.defineProperty(window.document, "visibilityState", { configurable: true, get: () => visibility });

  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const container = window.document.createElement("div");
  window.document.body.append(container);
  // SAFETY: Happy DOM implements the Element operations React DOM uses.
  const root = createRoot(container as unknown as Element);
  t.after(async () => {
    await act(async () => root.unmount());
    client.clear();
    await window.happyDOM.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  });

  const flush = () => act(async () => {
    for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  });

  /** What a person at the browser can read, select or copy: the concealed
   *  subtree is inert, so it is none of those. */
  const exposed = () => {
    const copy = container.cloneNode(true) as unknown as HTMLElement;
    for (const node of copy.querySelectorAll("[inert]")) node.remove();
    return copy.textContent ?? "";
  };
  /** Buttons still operable, the copy buttons included. */
  const operableButtons = () =>
    [...container.querySelectorAll("button")]
      .filter((button) => !button.closest("[inert]"))
      .map((button) => button.textContent?.trim());
  const assertConcealment = () => {
    for (const node of container.querySelectorAll("[inert]")) {
      assert.equal(node.getAttribute("aria-hidden"), "true");
      assert.ok(node.classList.contains("invisible"), "an inert subtree was still painted");
    }
  };

  /** Whether `needle` is ever exposed from now on, including between the
   *  flushes a test can see. */
  const watchExposed = (needle: string) => {
    let seen = false;
    const observer = new window.MutationObserver(() => {
      if (exposed().includes(needle)) seen = true;
    });
    observer.observe(container, { subtree: true, childList: true, characterData: true, attributes: true });
    t.after(() => observer.disconnect());
    return () => seen;
  };

  const pageEvent = (type: "pagehide" | "pageshow") => {
    const event = new window.Event(type);
    Object.defineProperty(event, "persisted", { value: true });
    window.dispatchEvent(event);
  };
  const setVisibility = (next: "visible" | "hidden") => {
    visibility = next;
    window.document.dispatchEvent(new window.Event("visibilitychange"));
  };

  /** Outside act on purpose: the browser freezes the page as soon as the
   *  handlers return, so the conceal has to be committed by then. */
  const leave = (kind: Return) => {
    const actEnvironment = Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT");
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", false);
    try {
      if (kind === "bfcache") pageEvent("pagehide");
      setVisibility("hidden");
    } finally {
      Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", actEnvironment);
    }
  };
  /** Chrome announces a restore with both events; the gate must check once. */
  const comeBack = async (kind: Return) => {
    await act(async () => {
      setVisibility("visible");
      if (kind === "bfcache") pageEvent("pageshow");
    });
    await flush();
  };

  server.signInDirectly("alice");
  await act(async () => root.render(
    React.createElement(QueryClientProvider, { client },
      React.createElement(BrowserRouter, null,
        React.createElement(RestoreGate, null,
          React.createElement(Routes, null,
            React.createElement(Route, { element: React.createElement(Shell) },
              React.createElement(Route, {
                path: "setup",
                element: React.createElement(RequireStage, { stage: "team", children: React.createElement(SetupPage) }),
              }),
            ),
          ),
        ),
      ),
    ),
  ));
  await flush();
  assert.ok(exposed().includes(tokenFor("alice")), "alice's setup command never painted");
  assert.ok(exposed().includes("Account menu for alice"));

  return { server, client, container, flush, exposed, watchExposed, operableButtons, assertConcealment, leave, comeBack };
}

for (const kind of ["bfcache", "visibility"] as const) {
  test(`${kind}: nothing of alice's shows while the session read is slow`, async (t) => {
    const h = await harness(t);
    h.leave(kind);
    assert.ok(!h.exposed().includes(tokenFor("alice")), "the conceal was not committed before the page froze");
    h.assertConcealment();

    h.server.signInDirectly("bob");
    h.server.session("hold");
    const before = h.server.sessionRequests.length;
    await h.comeBack(kind);
    assert.deepEqual(h.server.sessionRequests.slice(before), ["bob"], "the return did not read the session exactly once");

    // Still waiting: the loading mark and nothing of alice's.
    await h.flush();
    assert.ok(!h.exposed().includes(tokenFor("alice")));
    assert.ok(!h.exposed().includes("Account menu for alice"));
    assert.deepEqual(h.operableButtons(), [], "a copy button was still operable");
    assert.ok(h.container.querySelector('[role="status"]'), "no loading mark while waiting");
    h.assertConcealment();

    h.server.releaseSession("bob");
    await h.flush();
    assert.ok(h.exposed().includes(tokenFor("bob")));
    assert.ok(h.exposed().includes("Account menu for bob"));
    assert.ok(!h.container.textContent?.includes(tokenFor("alice")), "alice's tree survived the switch");
    assert.equal(h.container.querySelector("[inert]"), null);
  });

  test(`${kind}: a failed session read shows the error, and retrying reaches bob`, async (t) => {
    const h = await harness(t);
    h.leave(kind);
    h.server.signInDirectly("bob");
    h.server.session("fail");
    await h.comeBack(kind);

    assert.ok(!h.exposed().includes(tokenFor("alice")));
    assert.ok(!h.exposed().includes("Account menu for alice"));
    assert.deepEqual(h.operableButtons(), ["Try again"]);
    h.assertConcealment();

    h.server.session("answer");
    const retry = [...h.container.querySelectorAll("button")].find((button) => button.textContent === "Try again");
    await act(async () => retry!.click());
    await h.flush();
    assert.ok(h.exposed().includes(tokenFor("bob")));
    assert.ok(!h.container.textContent?.includes(tokenFor("alice")));
    assert.ok(!h.exposed().includes("Try again"));
  });

  test(`${kind}: alice's setup answer that lands after the switch never renders`, async (t) => {
    const h = await harness(t);
    // Alice's poll is on the wire when the page is put away.
    h.server.holdSetupState(true);
    await act(async () => { void h.client.invalidateQueries({ queryKey: ["setup-state"] }); });
    await h.flush();

    h.leave(kind);
    h.server.signInDirectly("bob");
    await h.comeBack(kind);
    h.server.releaseSetupState("bob");
    await h.flush();
    assert.ok(h.exposed().includes(tokenFor("bob")));

    const sawAlice = h.watchExposed(tokenFor("alice"));
    h.server.releaseSetupState("alice");
    await h.flush();
    assert.equal(sawAlice(), false, "alice's late answer rendered for bob");
    assert.ok(!h.container.textContent?.includes(tokenFor("alice")));
    assert.ok(h.exposed().includes(tokenFor("bob")));
  });

  test(`${kind}: the same account gets the same mounted page back`, async (t) => {
    const h = await harness(t);
    const heading = h.container.querySelector("h1");
    assert.ok(heading);

    h.leave(kind);
    assert.ok(!h.exposed().includes(tokenFor("alice")));
    await h.comeBack(kind);

    assert.ok(heading.isConnected, "the page was remounted for an unchanged account");
    assert.equal(h.container.querySelector("h1"), heading);
    assert.ok(h.exposed().includes(tokenFor("alice")));
    assert.equal(h.container.querySelector("[inert]"), null);
  });

  test(`${kind}: bob on another team never sees alice's team`, async (t) => {
    // The team, connections and dashboard answers are not keyed by account,
    // so only discarding the cache and remounting keeps them from bob.
    const h = await harness(t, "own");
    assert.ok(h.exposed().includes("Team of alice"));
    const heading = h.container.querySelector("h1");
    h.leave(kind);
    const sawAlice = h.watchExposed("Team of alice");
    h.server.signInDirectly("bob");
    await h.comeBack(kind);
    assert.ok(h.exposed().includes("Team of bob"));
    assert.equal(sawAlice(), false, "bob was shown alice's cached team");
    assert.ok(!h.container.textContent?.includes("Team of alice"));
    assert.equal(heading?.isConnected, false, "alice's page stayed mounted for bob");
  });

  test(`${kind}: a check overtaken by another hide never opens the gate`, async (t) => {
    const h = await harness(t);
    h.leave(kind);
    h.server.session("hold");
    await h.comeBack(kind);
    // Hidden again before alice's answer; bob signs in meanwhile.
    h.leave(kind);
    h.server.signInDirectly("bob");
    await h.comeBack(kind);
    // The first check's request is cancelled and resolves with the cached
    // session, which is alice's.
    assert.ok(!h.exposed().includes(tokenFor("alice")), "a superseded check opened the gate");
    h.server.releaseSession("alice");
    await h.flush();
    assert.ok(!h.exposed().includes(tokenFor("alice")));
    h.server.releaseSession("bob");
    await h.flush();
    assert.ok(h.exposed().includes(tokenFor("bob")));
    assert.ok(!h.container.textContent?.includes(tokenFor("alice")));
  });
}

test("a session read sent as alice before the switch is not taken as the answer", async (t) => {
  const h = await harness(t);
  h.server.session("hold");
  await act(async () => { void h.client.invalidateQueries({ queryKey: ["session"] }); });
  h.leave("visibility");
  h.server.signInDirectly("bob");
  h.server.session("answer");
  await h.comeBack("visibility");
  // Alice's read answers late; the gate asked again as bob and ignores it.
  h.server.releaseSession("alice");
  await h.flush();
  assert.ok(h.exposed().includes(tokenFor("bob")));
  assert.ok(!h.container.textContent?.includes(tokenFor("alice")));
});

test("a mutation alice sent before the switch cannot write into bob's cache", async (t) => {
  const h = await harness(t);
  // Stands in for any mutation whose onSuccess writes a shared entry, as
  // useUpdateTeam writes ["team"]; its response arrives after the switch.
  let answer!: (value: string) => void;
  const late = h.client.getMutationCache().build(h.client, {
    mutationFn: () => new Promise<string>((resolve) => { answer = resolve; }),
    onSuccess: (team: string) => { h.client.setQueryData(["team-written-by-mutation"], team); },
  });
  let settled = false;
  void late.execute(undefined).finally(() => { settled = true; });
  h.leave("bfcache");
  h.server.signInDirectly("bob");
  await h.comeBack("bfcache");
  // The gate knows it is bob, but waits for alice's write before clearing.
  assert.ok(!h.exposed().includes(tokenFor("bob")), "bob's page opened while alice's write was pending");
  assert.ok(!h.exposed().includes(tokenFor("alice")));

  await act(async () => answer("alice's team"));
  await h.flush();
  assert.ok(settled);
  assert.equal(h.client.getQueryData(["team-written-by-mutation"]), undefined, "alice's late write survived into bob's cache");
  assert.ok(h.exposed().includes(tokenFor("bob")));
});

test("a same-account restore from the back/forward cache rereads what it shows", async (t) => {
  const h = await harness(t);
  const reads = () => h.client.getQueryCache().findAll({ queryKey: ["setup-state"] })
    .reduce((sum, query) => sum + query.state.dataUpdateCount, 0);
  const before = reads();
  h.leave("bfcache");
  await h.comeBack("bfcache");
  await h.flush();
  assert.ok(reads() > before, "a restored page kept answers of unknown age");
  assert.ok(h.exposed().includes(tokenFor("alice")));

  // A tab that was only hidden keeps its answers, as before the gate.
  const afterRestore = reads();
  h.leave("visibility");
  await h.comeBack("visibility");
  await h.flush();
  assert.equal(reads(), afterRestore);
});

test("the same login on the same team is the same account", () => {
  const alice = sessionFor("alice");
  assert.equal(sameAccount(alice, sessionFor("alice")), true);
  assert.equal(sameAccount(alice, sessionFor("bob")), false);
  assert.equal(sameAccount(alice, sessionFor(null)), false);
  assert.equal(sameAccount(sessionFor(null), sessionFor(null)), true);
  // Moved to another team in another tab: every team-scoped answer is stale.
  assert.equal(sameAccount(alice, { ...alice, team: { ...alice.team!, id: "team_other" } }), false);
  // Nothing was read before the page was hidden, so nothing can be kept.
  assert.equal(sameAccount(undefined, alice), false);
});
