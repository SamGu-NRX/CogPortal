import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import * as React from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Window } from "happy-dom";

/**
 * The held device link from the guard to Setup's offer and back out through
 * approval. Setup only offers what the status endpoint says is open; every
 * other answer either forgets the link (the server said no) or keeps it
 * unshown (the server didn't answer), and nothing here navigates on its own.
 */

const KEY = "cogportal.heldDeviceLink";
const ORIGIN = "https://portal.example";
const PRINTED = "/connections?user_code=ABCD-EFGH&return_to=setup";

type Status = { valid: boolean; approved: boolean; expiresAt: number | null };
// Deadlines as the server sets them: ten minutes from the start, read at the
// moment of each answer.
const OPEN = (): Status => ({ valid: true, approved: false, expiresAt: Date.now() + 600_000 });
const EXPIRED = (): Status => ({ valid: false, approved: false, expiresAt: null });
const APPROVED = (): Status => ({ valid: true, approved: true, expiresAt: Date.now() + 600_000 });

const SESSION = {
  user: { login: "octocat", name: null, avatarUrl: null, platformRole: "student", isOwner: false, isTa: false },
  cohort: { slug: "bwsi", name: "BWSI" },
  team: null as null | { id: string; name: string; description: null; repo: null },
  auth: {
    githubConfigured: true, devAuthEnabled: false, onboardingDevToolsEnabled: false,
    appSlug: null, templateRepo: null, executionProvider: "fixture",
  },
};

/** What holdDeviceLink writes, written directly so a test can plant any path. */
const stored = (path: string, login = "octocat") =>
  JSON.stringify({ path, userCode: /user_code=([^&#]*)/.exec(path)?.[1]?.toUpperCase() ?? "", login });

/** Answers one request; return undefined for a request the test did not expect. */
type Reply = (url: URL, init: { method?: string }) => Response | Promise<Response> | undefined;

async function mount(t: TestContext, entry: string, reply: Reply, session: unknown = SESSION) {
  const window = new Window({ url: `${ORIGIN}${entry}` });
  const requests: string[] = [];
  const globals = {
    window, document: window.document, navigator: window.navigator,
    HTMLElement: window.HTMLElement, Element: window.Element, SVGElement: window.SVGElement,
    sessionStorage: window.sessionStorage, React, IS_REACT_ACT_ENVIRONMENT: true,
    fetch: async (input: string, init: { method?: string } = {}) => {
      const url = new URL(input, ORIGIN);
      requests.push(`${init.method ?? "GET"} ${url.pathname}${url.search}`);
      const response = await reply(url, init);
      if (!response) throw new Error(`unexpected request ${init.method ?? "GET"} ${url.pathname}`);
      return response;
    },
  };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  const client = new QueryClient({
    defaultOptions: {
      queries: { staleTime: Infinity, gcTime: Infinity, retry: false },
      mutations: { gcTime: Infinity },
    },
  });
  client.setQueryData(["session"], session);
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
  const render = (children: React.ReactNode) => act(async () => root.render(
    React.createElement(QueryClientProvider, { client },
      React.createElement(MemoryRouter, { initialEntries: [entry] }, children, React.createElement(Probe))),
  ));
  const settle = async () => {
    for (let index = 0; index < 10; index += 1) {
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    }
  };
  const location = () => container.querySelector("output[data-location]")?.getAttribute("data-location");
  return { window, container, requests, client, render, settle, location };
}

/** Where the router is, so a test can tell an offer from a redirect. */
function Probe() {
  const location = useLocation();
  return React.createElement("output", { "data-location": `${location.pathname}${location.search}` });
}

const statusReply = (answer: () => Response | Promise<Response>): Reply => (url) =>
  url.pathname === "/api/v1/cli/device/status" ? answer() : undefined;

async function offer() {
  // Imported after the globals exist: Motion decides at module load whether
  // it is running in a browser.
  return (await import("../src/components/HeldDeviceLinkOffer.tsx")).HeldDeviceLinkOffer;
}

const card = (container: HTMLElement) => container.querySelector('section[aria-label="Your earlier device link"]');
/** Whether the offer is on the page, as a boolean: a failed assert.equal on
 *  a Happy DOM node formats its whole graph and stalls the runner. */
const offerShown = (container: HTMLElement) => card(container) !== null;

test("the guard holds the printed approval for the account it bounces, and still sends it to /connect", async (t) => {
  const { window, container, render, settle, location, requests } = await mount(t, PRINTED, () => undefined);
  const { RequireStage } = await import("../src/App.tsx");
  await render(React.createElement(Routes, null,
    React.createElement(Route, {
      path: "/connections",
      element: React.createElement(RequireStage, { stage: "team" }, React.createElement("p", null, "approval form")),
    }),
    React.createElement(Route, { path: "*", element: null }),
  ));
  await settle();

  assert.equal(location(), "/connect");
  assert.doesNotMatch(container.textContent ?? "", /approval form/);
  assert.deepEqual(JSON.parse(window.sessionStorage.getItem(KEY) ?? "null"), {
    path: PRINTED, userCode: "ABCD-EFGH", login: "octocat",
  });
  assert.deepEqual(requests, [], "holding the link asks the server nothing");
});

test("the guard holds nothing for a Discord link, a signed-out visitor, or a student with a team", async (t) => {
  const cases: Array<{ entry: string; session: unknown }> = [
    { entry: "/connections#discord=state-token", session: SESSION },
    { entry: PRINTED, session: { ...SESSION, user: null, cohort: null } },
    { entry: PRINTED, session: { ...SESSION, team: { id: "team_1", name: "Team One", description: null, repo: null } } },
  ];
  for (const { entry, session } of cases) {
    await t.test(entry, async (t) => {
      const { window, render, settle } = await mount(t, entry, () => undefined, session);
      const { RequireStage } = await import("../src/App.tsx");
      await render(React.createElement(Routes, null,
        React.createElement(Route, {
          path: "/connections",
          element: React.createElement(RequireStage, { stage: "team" }, React.createElement("p", null, "approval form")),
        }),
        React.createElement(Route, { path: "*", element: null }),
      ));
      await settle();
      assert.equal(window.sessionStorage.getItem(KEY), null);
    });
  }
});

test("an open code is offered as a link to the same approval page, and nothing navigates until it is followed", async (t) => {
  const { window, container, requests, render, settle, location } = await mount(t, "/setup", statusReply(() => Response.json(OPEN())));
  window.sessionStorage.setItem(KEY, stored(PRINTED));
  const HeldDeviceLinkOffer = await offer();
  await render(React.createElement(HeldDeviceLinkOffer, { login: "octocat" }));
  await settle();

  assert.deepEqual(requests, ["GET /api/v1/cli/device/status?user_code=ABCD-EFGH"]);
  const section = card(container);
  assert.ok(section, "the offer is shown");
  assert.match(section.textContent ?? "", /Code ABCD-EFGH hasn't expired or been approved/);
  assert.doesNotMatch(section.textContent ?? "", /still waiting|is waiting/, "the page can't see the terminal, so it doesn't claim it");
  assert.equal(location(), "/setup", "the offer does not navigate on its own");
  assert.ok(window.sessionStorage.getItem(KEY), "showing the offer keeps the link");

  const link = [...section.querySelectorAll("a")].find((anchor) => anchor.textContent === "Review and approve");
  assert.equal(link?.getAttribute("href"), PRINTED);
  await act(async () => link?.click());
  assert.equal(location(), PRINTED, "following it opens the original approval path");
});

test("a code the server calls expired, consumed or approved is not offered, and is forgotten", async (t) => {
  for (const [name, status] of [["expired or consumed", EXPIRED], ["already approved", APPROVED]] as const) {
    await t.test(name, async (t) => {
      const { window, container, render, settle } = await mount(t, "/setup", statusReply(() => Response.json(status())));
      window.sessionStorage.setItem(KEY, stored(PRINTED));
      const HeldDeviceLinkOffer = await offer();
      await render(React.createElement(HeldDeviceLinkOffer, { login: "octocat" }));
      await settle();
      assert.equal(offerShown(container), false);
      assert.equal(container.textContent, "");
      assert.equal(window.sessionStorage.getItem(KEY), null);
    });
  }
});

test("an unanswered check shows nothing and keeps the link, because it isn't an expiry", async (t) => {
  const failures: Array<[string, () => Response | Promise<Response>]> = [
    ["server error", () => new Response("", { status: 503 })],
    ["network failure", () => Promise.reject(new TypeError("Failed to fetch"))],
    ["unreadable answer", () => Response.json({ valid: "yes" })],
  ];
  for (const [name, answer] of failures) {
    await t.test(name, async (t) => {
      const { window, container, requests, render, settle } = await mount(t, "/setup", statusReply(answer));
      window.sessionStorage.setItem(KEY, stored(PRINTED));
      const HeldDeviceLinkOffer = await offer();
      await render(React.createElement(HeldDeviceLinkOffer, { login: "octocat" }));
      await settle();
      assert.equal(requests.length, 1, "asked once, without retrying");
      assert.equal(offerShown(container), false);
      assert.equal(JSON.parse(window.sessionStorage.getItem(KEY) ?? "null")?.path, PRINTED);
    });
  }
});

test("a late answer about an older code doesn't forget a newer held link", async (t) => {
  let answer: (response: Response) => void = () => {};
  const { window, container, render, settle } = await mount(
    t, "/setup", statusReply(() => new Promise<Response>((resolve) => { answer = resolve; })),
  );
  window.sessionStorage.setItem(KEY, stored(PRINTED));
  const HeldDeviceLinkOffer = await offer();
  await render(React.createElement(HeldDeviceLinkOffer, { login: "octocat" }));
  await settle();
  const newer = "/connections?user_code=WXYZ-2345&return_to=setup";
  window.sessionStorage.setItem(KEY, stored(newer));
  answer(Response.json(EXPIRED()));
  await settle();

  assert.equal(offerShown(container), false);
  assert.equal(JSON.parse(window.sessionStorage.getItem(KEY) ?? "null")?.path, newer);
});

test("dismissing forgets this code only, and the line that replaces the offer takes focus", async (t) => {
  const { window, container, render, settle, location } = await mount(t, "/setup", statusReply(() => Response.json(OPEN())));
  window.sessionStorage.setItem(KEY, stored(PRINTED));
  const HeldDeviceLinkOffer = await offer();
  await render(React.createElement(HeldDeviceLinkOffer, { login: "octocat" }));
  await settle();
  const dismiss = [...container.querySelectorAll("button")].find((button) => button.textContent === "Dismiss");
  assert.ok(dismiss);
  dismiss.focus();
  await act(async () => dismiss.click());

  assert.equal(offerShown(container), false);
  assert.equal(window.sessionStorage.getItem(KEY), null);
  const line = container.querySelector('p[role="status"]');
  assert.match(line?.textContent ?? "", /^Setup won't offer that code again\. To link a machine later, run cogworks link --portal https:\/\/portal\.example in its terminal\.$/);
  assert.ok(window.document.activeElement === line, "focus moves to the line, not the page");
  assert.equal(location(), "/setup");
});

test("dismissing an offer leaves a link held after it in place", async (t) => {
  const { window, container, render, settle } = await mount(t, "/setup", statusReply(() => Response.json(OPEN())));
  window.sessionStorage.setItem(KEY, stored(PRINTED));
  const HeldDeviceLinkOffer = await offer();
  await render(React.createElement(HeldDeviceLinkOffer, { login: "octocat" }));
  await settle();
  const newer = "/connections?user_code=WXYZ-2345&return_to=setup";
  window.sessionStorage.setItem(KEY, stored(newer));
  const dismiss = [...container.querySelectorAll("button")].find((button) => button.textContent === "Dismiss");
  await act(async () => dismiss?.click());
  assert.equal(JSON.parse(window.sessionStorage.getItem(KEY) ?? "null")?.path, newer);
});

test("another account in the tab sees no offer and the server is not asked", async (t) => {
  const { window, container, requests, render, settle } = await mount(t, "/setup", statusReply(() => Response.json(OPEN())));
  window.sessionStorage.setItem(KEY, stored(PRINTED, "octocat"));
  const HeldDeviceLinkOffer = await offer();
  await render(React.createElement(HeldDeviceLinkOffer, { login: "hubot" }));
  await settle();
  assert.equal(offerShown(container), false);
  assert.deepEqual(requests, []);
  assert.equal(window.sessionStorage.getItem(KEY), null);
});

test("switching accounts under a shown offer removes it (Setup keys the offer by login)", async (t) => {
  const { window, container, render, settle } = await mount(t, "/setup", statusReply(() => Response.json(OPEN())));
  window.sessionStorage.setItem(KEY, stored(PRINTED, "octocat"));
  const HeldDeviceLinkOffer = await offer();
  await render(React.createElement(HeldDeviceLinkOffer, { key: "octocat", login: "octocat" }));
  await settle();
  assert.ok(card(container));
  await render(React.createElement(HeldDeviceLinkOffer, { key: "hubot", login: "hubot" }));
  await settle();
  assert.equal(offerShown(container), false);
  assert.equal(window.sessionStorage.getItem(KEY), null);
});

test("a planted path that isn't the CLI's approval page is never offered or fetched", async (t) => {
  for (const path of ["https://evil.example/connections?user_code=ABCD-EFGH", "/connections#discord=state-token", "/connections?user_code=ABCD-EFGH&next=/admin"]) {
    await t.test(path, async (t) => {
      const { window, container, requests, render, settle } = await mount(t, "/setup", statusReply(() => Response.json(OPEN())));
      window.sessionStorage.setItem(KEY, stored(path));
      const HeldDeviceLinkOffer = await offer();
      await render(React.createElement(HeldDeviceLinkOffer, { login: "octocat" }));
      await settle();
      assert.equal(offerShown(container), false);
      assert.deepEqual(requests, []);
      assert.equal(window.sessionStorage.getItem(KEY), null);
    });
  }
});

test("Setup still renders when the browser denies session storage", async (t) => {
  const { container, requests, render, settle } = await mount(t, "/setup", statusReply(() => Response.json(OPEN())));
  const previous = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage");
  Object.defineProperty(globalThis, "sessionStorage", {
    configurable: true,
    get() { throw new DOMException("The operation is insecure.", "SecurityError"); },
  });
  t.after(() => { if (previous) Object.defineProperty(globalThis, "sessionStorage", previous); });
  const HeldDeviceLinkOffer = await offer();
  await render(React.createElement(React.Fragment, null,
    React.createElement(HeldDeviceLinkOffer, { login: "octocat" }), React.createElement("h1", null, "Setup")));
  await settle();
  assert.equal(offerShown(container), false);
  assert.deepEqual(requests, []);
  assert.match(container.textContent ?? "", /Setup/);
});

test("approving a held code on Connections forgets it, and leaves a different held code alone", async (t) => {
  for (const [name, held, kept] of [
    ["the same code", PRINTED, null],
    ["a different code", "/connections?user_code=WXYZ-2345&return_to=setup", "/connections?user_code=WXYZ-2345&return_to=setup"],
  ] as const) {
    await t.test(name, async (t) => {
      const connections = { github: null, discord: null, cliDevices: [] };
      const { window, container, requests, render, settle } = await mount(t, "/connections?user_code=abcd-efgh", (url, init) => {
        if (url.pathname === "/api/v1/connections") return Response.json(connections);
        if (url.pathname === "/api/v1/cli/device/approve" && init.method === "POST") return Response.json({ ok: true });
        return undefined;
      }, { ...SESSION, team: { id: "team_1", name: "Team One", description: null, repo: null } });
      window.sessionStorage.setItem(KEY, stored(held));
      const { ConnectionsPage } = await import("../src/routes/ConnectionsPage.tsx");
      await render(React.createElement(ConnectionsPage));
      await settle();
      const approve = [...container.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Approve device");
      assert.ok(approve);
      await act(async () => approve.click());
      await settle();
      assert.ok(requests.includes("POST /api/v1/cli/device/approve"));
      assert.equal(JSON.parse(window.sessionStorage.getItem(KEY) ?? "null")?.path ?? null, kept);
    });
  }
});

const TEAM_SESSION = { ...SESSION, team: { id: "team_1", name: "Team One", description: null, repo: null } };

test("an answer from an earlier visit is never shown: each visit waits for its own, and a failed one shows nothing", async (t) => {
  let reply: () => Response | Promise<Response> = () => Response.json(OPEN());
  const { window, container, requests, render, settle } = await mount(t, "/setup", statusReply(() => reply()));
  window.sessionStorage.setItem(KEY, stored(PRINTED));
  const HeldDeviceLinkOffer = await offer();
  await render(React.createElement(HeldDeviceLinkOffer, { key: "first visit", login: "octocat" }));
  await settle();
  assert.ok(card(container), "the first visit's own answer shows the offer");
  await render(null);
  await settle();

  let answer: (response: Response) => void = () => {};
  reply = () => new Promise<Response>((resolve) => { answer = resolve; });
  await render(React.createElement(HeldDeviceLinkOffer, { key: "second visit", login: "octocat" }));
  await settle();
  assert.equal(requests.length, 2, "the second visit asks again");
  assert.equal(offerShown(container), false, "nothing is shown while this visit's check is out");
  answer(new Response("", { status: 503 }));
  await settle();
  assert.equal(offerShown(container), false, "nor after it fails");
  assert.equal(JSON.parse(window.sessionStorage.getItem(KEY) ?? "null")?.path, PRINTED);
});

test("an offer doesn't outlive its code: it goes at the deadline without asking again, and the next visit's check releases the link", async (t) => {
  let reply: () => Response = () => Response.json({ valid: true, approved: false, expiresAt: Date.now() + 200 });
  const { window, container, requests, render, settle } = await mount(t, "/setup", statusReply(() => reply()));
  window.sessionStorage.setItem(KEY, stored(PRINTED));
  const HeldDeviceLinkOffer = await offer();
  await render(React.createElement(HeldDeviceLinkOffer, { key: "first visit", login: "octocat" }));
  await settle();
  assert.ok(card(container), "shown before the deadline");
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 400)); });
  await settle();
  assert.equal(offerShown(container), false, "gone at the deadline, with nothing else rendering the page");
  assert.equal(requests.length, 1, "without asking the server again");
  assert.ok(window.sessionStorage.getItem(KEY), "only the server's answer releases the link");

  reply = () => Response.json(EXPIRED());
  await render(null);
  await settle();
  await render(React.createElement(HeldDeviceLinkOffer, { key: "next visit", login: "octocat" }));
  await settle();
  assert.equal(requests.length, 2);
  assert.equal(window.sessionStorage.getItem(KEY), null, "the next visit's check releases it");
});

test("an answer already past its deadline on this clock shows nothing and keeps the link for the next visit", async (t) => {
  const { window, container, requests, render, settle } = await mount(
    t, "/setup", statusReply(() => Response.json({ valid: true, approved: false, expiresAt: Date.now() - 1_000 })),
  );
  window.sessionStorage.setItem(KEY, stored(PRINTED));
  const HeldDeviceLinkOffer = await offer();
  await render(React.createElement(HeldDeviceLinkOffer, { login: "octocat" }));
  await settle();
  assert.equal(offerShown(container), false);
  assert.equal(requests.length, 1);
  assert.ok(window.sessionStorage.getItem(KEY));
});

test("an approval that finishes after Connections has gone still forgets the code it approved, and only that code", async (t) => {
  for (const [name, held, kept] of [
    ["the same code", PRINTED, null],
    ["a different code", "/connections?user_code=WXYZ-2345&return_to=setup", "/connections?user_code=WXYZ-2345&return_to=setup"],
  ] as const) {
    await t.test(name, async (t) => {
      const connections = { github: null, discord: null, cliDevices: [] };
      let finish: (response: Response) => void = () => {};
      const { window, container, requests, render, settle } = await mount(t, "/connections?user_code=abcd-efgh", (url, init) => {
        if (url.pathname === "/api/v1/connections") return Response.json(connections);
        if (url.pathname === "/api/v1/cli/device/approve" && init.method === "POST") {
          return new Promise<Response>((resolve) => { finish = resolve; });
        }
        return undefined;
      }, TEAM_SESSION);
      window.sessionStorage.setItem(KEY, stored(held));
      const { ConnectionsPage } = await import("../src/routes/ConnectionsPage.tsx");
      await render(React.createElement(ConnectionsPage));
      await settle();
      const approve = [...container.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Approve device");
      assert.ok(approve);
      await act(async () => approve.click());
      await settle();
      assert.ok(requests.includes("POST /api/v1/cli/device/approve"));

      await render(React.createElement("p", null, "another page"));
      await settle();
      assert.ok(window.sessionStorage.getItem(KEY), "nothing is released before the server answers");
      finish(Response.json({ ok: true }));
      await settle();
      assert.equal(JSON.parse(window.sessionStorage.getItem(KEY) ?? "null")?.path ?? null, kept);
    });
  }
});

test("a link another account held is forgotten on any page, as soon as the signed-in account changes", async (t) => {
  const { window, client, render, settle } = await mount(t, "/leaderboard", () => undefined, SESSION);
  window.sessionStorage.setItem(KEY, stored(PRINTED, "hubot"));
  const { HeldDeviceLinkAccountCheck } = await import("../src/components/HeldDeviceLinkOffer.tsx");
  await render(React.createElement(HeldDeviceLinkAccountCheck));
  await settle();
  assert.equal(window.sessionStorage.getItem(KEY), null, "hubot's link, with octocat signed in");

  window.sessionStorage.setItem(KEY, stored(PRINTED, "octocat"));
  await act(async () => { client.setQueryData(["session"], { ...SESSION, user: { ...SESSION.user, login: "octocat" } }); });
  await settle();
  assert.ok(window.sessionStorage.getItem(KEY), "the account's own link stays");
  await act(async () => { client.setQueryData(["session"], { ...SESSION, user: { ...SESSION.user, login: "hubot" } }); });
  await settle();
  assert.equal(window.sessionStorage.getItem(KEY), null, "octocat's link once hubot is signed in, without a guarded page");
  await act(async () => { client.setQueryData(["session"], SESSION); });
  await settle();
  assert.equal(window.sessionStorage.getItem(KEY), null, "and it stays forgotten when octocat is back");
});

test("a check that fails while the offer is up takes the offer down, and keeps the link", async (t) => {
  let reply: () => Response = () => Response.json(OPEN());
  const { window, container, client, render, settle } = await mount(t, "/setup", statusReply(() => reply()));
  window.sessionStorage.setItem(KEY, stored(PRINTED));
  const HeldDeviceLinkOffer = await offer();
  await render(React.createElement(HeldDeviceLinkOffer, { login: "octocat" }));
  await settle();
  assert.ok(card(container));
  // Well before the deadline, so only the failed answer can take it down.
  reply = () => new Response("", { status: 503 });
  await act(async () => { await client.refetchQueries({ queryKey: ["device-link-status"] }); });
  await settle();
  assert.equal(offerShown(container), false, "the earlier answer is not shown once a check has failed");
  assert.ok(window.sessionStorage.getItem(KEY));
});

test("only an answer from this visit counts, whatever the clock does between visits", async (t) => {
  await t.test("a remount in the same clock tick, while the earlier visit's check is still out", async (t) => {
    const frozen = Date.now();
    t.mock.method(Date, "now", () => frozen);
    let reply: () => Response | Promise<Response> = () => Response.json(OPEN());
    const { window, container, client, render, settle } = await mount(t, "/setup", statusReply(() => reply()));
    window.sessionStorage.setItem(KEY, stored(PRINTED));
    const HeldDeviceLinkOffer = await offer();
    await render(React.createElement(HeldDeviceLinkOffer, { key: "first visit", login: "octocat" }));
    await settle();
    assert.ok(card(container));
    let answer: (response: Response) => void = () => {};
    reply = () => new Promise<Response>((resolve) => { answer = resolve; });
    // A refetch the first visit leaves unanswered; a fetching query is never collected.
    void client.refetchQueries({ queryKey: ["device-link-status"] });
    await settle();
    await render(null);
    await settle();
    await render(React.createElement(HeldDeviceLinkOffer, { key: "second visit", login: "octocat" }));
    await settle();
    assert.equal(offerShown(container), false, "the earlier answer isn't this visit's");
    answer(Response.json(EXPIRED()));
    await settle();
    assert.equal(offerShown(container), false);
    assert.equal(window.sessionStorage.getItem(KEY), null);
  });

  await t.test("a clock set back between visits doesn't hide this visit's answer", async (t) => {
    let clock = Date.now();
    t.mock.method(Date, "now", () => clock);
    const { window, container, render, settle } = await mount(t, "/setup", statusReply(() => Response.json(OPEN())));
    window.sessionStorage.setItem(KEY, stored(PRINTED));
    const HeldDeviceLinkOffer = await offer();
    await render(React.createElement(HeldDeviceLinkOffer, { key: "first visit", login: "octocat" }));
    await settle();
    assert.ok(card(container));
    await render(null);
    await settle();
    clock -= 60_000;
    await render(React.createElement(HeldDeviceLinkOffer, { key: "second visit", login: "octocat" }));
    await settle();
    assert.ok(card(container), "this visit's own open answer is shown");
  });
});

test("returning to Setup before an approval answers: the offer goes once it does, whatever order the answers come in", async (t) => {
  for (const order of ["status answers first", "approval answers first"] as const) {
    await t.test(order, async (t) => {
      const connections = { github: null, discord: null, cliDevices: [] };
      let finishApproval: (response: Response) => void = () => {};
      let answerStatus: (response: Response) => void = () => {};
      const { window, container, requests, render, settle } = await mount(t, "/connections?user_code=abcd-efgh", (url, init) => {
        if (url.pathname === "/api/v1/connections") return Response.json(connections);
        if (url.pathname === "/api/v1/cli/device/approve" && init.method === "POST") {
          return new Promise<Response>((resolve) => { finishApproval = resolve; });
        }
        if (url.pathname === "/api/v1/cli/device/status") return new Promise<Response>((resolve) => { answerStatus = resolve; });
        return undefined;
      }, TEAM_SESSION);
      window.sessionStorage.setItem(KEY, stored(PRINTED));
      const { ConnectionsPage } = await import("../src/routes/ConnectionsPage.tsx");
      await render(React.createElement(ConnectionsPage));
      await settle();
      const approve = [...container.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Approve device");
      await act(async () => approve?.click());
      await settle();

      // Back on Setup while the approval is out; Setup asks about the code.
      const HeldDeviceLinkOffer = await offer();
      await render(React.createElement(HeldDeviceLinkOffer, { login: "octocat" }));
      await settle();
      assert.ok(requests.some((request) => request.startsWith("GET /api/v1/cli/device/status")));
      if (order === "status answers first") {
        answerStatus(Response.json(OPEN()));
        await settle();
        assert.ok(card(container), "open as far as Setup's check knew");
        finishApproval(Response.json({ ok: true }));
        await settle();
      } else {
        finishApproval(Response.json({ ok: true }));
        await settle();
        // Sent before the approval, so it says open; it must not count.
        answerStatus(Response.json(OPEN()));
        await settle();
      }
      assert.equal(offerShown(container), false);
      assert.equal(window.sessionStorage.getItem(KEY), null);
    });
  }
});

test("the offer is announced when it arrives, from a status region that was there before it, with the controls outside it", async (t) => {
  let answer: (response: Response) => void = () => {};
  const { window, container, render, settle } = await mount(
    t, "/setup", statusReply(() => new Promise<Response>((resolve) => { answer = resolve; })),
  );
  window.sessionStorage.setItem(KEY, stored(PRINTED));
  const HeldDeviceLinkOffer = await offer();
  await render(React.createElement(HeldDeviceLinkOffer, { login: "octocat" }));
  await settle();
  const region = container.querySelector('p[role="status"]');
  assert.ok(region, "the status region is mounted before the answer");
  assert.equal(region.textContent, "");
  answer(Response.json(OPEN()));
  await settle();
  assert.ok(container.querySelector('p[role="status"]') === region, "the same region, not a new one");
  assert.equal(region.textContent, "Your earlier device link is available: code ABCD-EFGH.");
  assert.equal(region.querySelectorAll("a, button").length, 0);
});

test("when the card goes on its own while one of its controls has focus, focus goes to the page heading; focus elsewhere stays", async (t) => {
  const cases = [
    { name: "deadline, link focused", deadline: 200, failRefetch: false, focus: "link" },
    { name: "failed check, Dismiss focused", deadline: 600_000, failRefetch: true, focus: "dismiss" },
    { name: "deadline, focus outside the card", deadline: 200, failRefetch: false, focus: "outside" },
  ] as const;
  for (const { name, deadline, failRefetch, focus } of cases) {
    await t.test(name, async (t) => {
      let reply: () => Response = () => Response.json({ valid: true, approved: false, expiresAt: Date.now() + deadline });
      const { window, container, client, render, settle } = await mount(t, "/setup", statusReply(() => reply()));
      window.sessionStorage.setItem(KEY, stored(PRINTED));
      const HeldDeviceLinkOffer = await offer();
      await render(React.createElement("main", null,
        React.createElement("h1", null, "Set up your machine"),
        React.createElement(HeldDeviceLinkOffer, { login: "octocat" }),
        React.createElement("button", { type: "button" }, "Copy command")));
      await settle();
      const section = card(container);
      assert.ok(section);
      const target = focus === "link"
        ? section.querySelector("a")
        : focus === "dismiss"
          ? [...section.querySelectorAll("button")].find((button) => button.textContent === "Dismiss")
          : [...container.querySelectorAll("button")].find((button) => button.textContent === "Copy command");
      assert.ok(target);
      target.focus();
      if (failRefetch) {
        reply = () => new Response("", { status: 503 });
        await act(async () => { await client.refetchQueries({ queryKey: ["device-link-status"] }); });
      } else {
        await act(async () => { await new Promise((resolve) => setTimeout(resolve, 400)); });
      }
      await settle();
      assert.equal(offerShown(container), false);
      const heading = container.querySelector("h1");
      const expected = focus === "outside" ? target : heading;
      assert.ok(window.document.activeElement === expected, `focus is on ${window.document.activeElement?.tagName}, expected ${expected?.tagName}`);
    });
  }
});
