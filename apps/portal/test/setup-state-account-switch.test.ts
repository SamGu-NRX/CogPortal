import assert from "node:assert/strict";
import test from "node:test";
import * as React from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Window } from "happy-dom";
import { useDevLogin, useLogout, useSession, useSetupState } from "../src/lib/queries.ts";

// The setup page's check-off command carries a bearer token signed for one
// account. These tests sign one account out and another in within the same
// tab, through the real hooks, and check that the second account is never
// shown a token minted for the first.

const BENCHMARK = "vision-recognition";

function sessionFor(login: string | null) {
  return {
    user: login
      ? { login, name: login, avatarUrl: null, platformRole: "student", isOwner: false, isTa: false }
      : null,
    cohort: login ? { slug: "bwsi-2026", name: "BWSI CogWorks 2026" } : null,
    // One team for both accounts, as in the browser reproduction: the tokens
    // differ by account even when the team is shared.
    team: login
      ? { id: "team_shared", name: "Shared", description: null, provenance: "live", repo: null }
      : null,
    auth: {
      githubConfigured: false,
      devAuthEnabled: true,
      onboardingDevToolsEnabled: false,
      appSlug: null,
      templateRepo: null,
      executionProvider: "fixture",
    },
  };
}

const tokenFor = (login: string) => `token-for-${login}`;

/** A stand-in for the worker. Each setup-state request is answered for the
 *  account whose cookie it carried when it was sent, which is what a real
 *  response that arrives after a sign-out still contains. */
function portal() {
  let signedIn: string | null = null;
  let hold = false;
  const held: { as: string | null; release: () => void }[] = [];
  const fetch = async (input: string, init?: { method?: string; body?: string }) => {
    const url = new URL(input, "https://portal.example");
    if (url.pathname === "/api/session") return Response.json(sessionFor(signedIn));
    if (url.pathname === "/api/session/logout") {
      signedIn = null;
      return Response.json({});
    }
    if (url.pathname === "/api/dev/login") {
      signedIn = (JSON.parse(init?.body ?? "{}") as { login: string }).login;
      return Response.json(sessionFor(signedIn));
    }
    if (url.pathname === "/api/v1/setup/state") {
      const as = signedIn;
      const answer = () =>
        as === null
          ? Response.json({ error: { code: "unauthorized", message: "Sign in." } }, { status: 401 })
          : Response.json({
              verified: [],
              verifiedByBenchmark: {},
              checked: [],
              checkedByBenchmark: {},
              tokens: { clone: tokenFor(as) },
            });
      if (!hold) return answer();
      return new Promise<Response>((resolve) => held.push({ as, release: () => resolve(answer()) }));
    }
    throw new Error(`unexpected request ${url.pathname}`);
  };
  return {
    fetch,
    signInDirectly: (login: string) => { signedIn = login; },
    holdSetupState: (value: boolean) => { hold = value; },
    release(as: string) {
      const index = held.findIndex((entry) => entry.as === as);
      assert.notEqual(index, -1, `no setup-state request was sent as ${as}`);
      held.splice(index, 1)[0].release();
    },
  };
}

function harness(t: test.TestContext) {
  const window = new Window({ url: "https://portal.example/setup" });
  const server = portal();
  const globals = {
    window, document: window.document, navigator: window.navigator,
    HTMLElement: window.HTMLElement, ResizeObserver: window.ResizeObserver, React, IS_REACT_ACT_ENVIRONMENT: true,
    fetch: server.fetch,
  };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const container = window.document.createElement("div");
  window.document.body.append(container);
  // SAFETY: Happy DOM implements the Element operations React uses.
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

  // Every token the setup reader ever rendered, including transient renders
  // between the flushes the test can see.
  const rendered: string[] = [];
  let controls: { logout: ReturnType<typeof useLogout>; devLogin: ReturnType<typeof useDevLogin> } | undefined;

  // Stands in for the shell: it always reads the session, as the header does.
  function Shell({ setup }: { setup: boolean }) {
    useSession();
    controls = { logout: useLogout(), devLogin: useDevLogin() };
    return setup ? React.createElement(SetupReader) : null;
  }
  function SetupReader() {
    const token = useSetupState(BENCHMARK).data?.tokens?.clone;
    if (token) rendered.push(token);
    return React.createElement("p", null, token ?? "waiting");
  }

  const flush = () => act(async () => {
    for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  });
  const show = async (setup: boolean) => {
    await act(async () => root.render(
      React.createElement(QueryClientProvider, { client }, React.createElement(Shell, { setup })),
    ));
    await flush();
  };
  const switchAccount = async (to: string) => {
    await act(async () => { await controls!.logout.mutateAsync(); });
    await act(async () => { await controls!.devLogin.mutateAsync({ login: to }); });
    await flush();
  };
  return { server, rendered, container, show, flush, switchAccount };
}

test("a setup answer cached for one account is not shown to the next one", async (t) => {
  const { server, rendered, container, show, flush, switchAccount } = harness(t);
  server.signInDirectly("alice");
  await show(true);
  assert.equal(container.textContent, tokenFor("alice"));

  // Alice leaves the setup page, so its entry is no longer being watched, then
  // signs out. Bob signs in and opens setup while his own answer is slow.
  await show(false);
  server.holdSetupState(true);
  await switchAccount("bob");
  rendered.length = 0;
  await show(true);
  assert.deepEqual(rendered, [], "bob saw a token before his own answer arrived");

  server.release("bob");
  await flush();
  assert.equal(container.textContent, tokenFor("bob"));
  assert.ok(!rendered.includes(tokenFor("alice")));
});

test("an answer alice's request receives after she signs out never reaches bob", async (t) => {
  const { server, rendered, container, show, flush, switchAccount } = harness(t);
  server.signInDirectly("alice");
  server.holdSetupState(true);
  // Alice opens setup; her first answer is still on the wire when she leaves
  // and signs out.
  await show(true);
  await show(false);
  await switchAccount("bob");
  rendered.length = 0;
  await show(true);

  server.release("alice");
  await flush();
  assert.ok(!rendered.includes(tokenFor("alice")), "alice's late answer rendered for bob");

  server.release("bob");
  await flush();
  assert.equal(container.textContent, tokenFor("bob"));
});
