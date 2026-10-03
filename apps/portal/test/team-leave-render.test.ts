import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import * as React from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { onlineManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Window } from "happy-dom";

/**
 * Leaving from the Team page, through the real stage guard, to the team
 * choice. The first version carried its "You left" notice in router state and
 * lost it in the browser: emptying the cached session made the Team page's
 * guard redirect to /connect after our own navigation, with no state. These
 * mount both guarded routes, as App does, so the guard is in the path.
 */

const TEAM_ID = "team_vision";
const TEAM_NAME = "Vision Squad";

const OTHER_TEAM_ID = "team_audio";

function sessionFor(team: boolean | "other") {
  return {
    user: { login: "student", name: null, avatarUrl: null, platformRole: "student", isOwner: false, isTa: false },
    cohort: { slug: "bwsi-2026", name: "BWSI CogWorks 2026" },
    team: team === "other"
      ? {
          id: OTHER_TEAM_ID, name: "Audio Crew", description: null, provenance: "live",
          repo: { owner: "octo", name: "audio", fullName: "octo/audio", url: "https://github.com/octo/audio", defaultBranch: "main" },
        }
      : team
      ? {
          id: TEAM_ID, name: TEAM_NAME, description: null, provenance: "live",
          repo: { owner: "octo", name: "face-finder", fullName: "octo/face-finder", url: "https://github.com/octo/face-finder", defaultBranch: "main" },
        }
      : null,
    auth: {
      githubConfigured: true, devAuthEnabled: false, onboardingDevToolsEnabled: false,
      appSlug: null, templateRepo: null, executionProvider: "fixture",
    },
  };
}

function teamDetail(members: number, teammateLogin = "teammate", archive = false) {
  return {
    ...sessionFor(true).team,
    provenance: archive ? "archive" : "live",
    members: [
      { login: "student", name: null, avatarUrl: null, role: "write", isYou: true },
      ...(members > 1 ? [{ login: teammateLogin, name: null, avatarUrl: null, role: "admin", isYou: false }] : []),
    ],
    tas: [],
    isAdmin: false,
  };
}

/** Stands in for the worker. Requests the test does not care about answer
 *  404 in the API's own error shape, so a panel that wants them renders its
 *  error rather than throwing. */
function portal(options: { members: number; alreadyLeft?: boolean; holdLeave?: boolean; teammateLogin?: string; archive?: boolean }) {
  let onTeam: boolean | "other" = true;
  let sessionMode: "answer" | "hold-next" | "fail" | "offline" = "answer";
  let joinWrites = 0;
  let releaseSession = () => {};
  const leaves: unknown[] = [];
  let release = () => {};
  const fetch = async (input: string, init?: RequestInit) => {
    const path = new URL(input, "https://portal.example").pathname;
    if (path === "/api/session") {
      if (sessionMode === "fail") return Response.json({ error: { code: "not_found", message: "Not here." } }, { status: 503 });
      if (sessionMode === "offline") throw new TypeError("Failed to fetch");
      // Answered as the server stood when the read arrived, not when it lands.
      const answer = Response.json(sessionFor(onTeam));
      if (sessionMode !== "hold-next") return answer;
      sessionMode = "answer";
      return new Promise<Response>((resolve) => { releaseSession = () => resolve(answer); });
    }
    if (path === "/api/team" && onTeam === true) return Response.json(teamDetail(options.members, options.teammateLogin, options.archive));
    if (path === "/api/team/leave") {
      leaves.push(JSON.parse(String(init?.body)));
      onTeam = false;
      const answer = Response.json({ alreadyLeft: options.alreadyLeft ?? false });
      if (!options.holdLeave) return answer;
      // The delete has committed; only the response is late.
      return new Promise<Response>((resolve) => { release = () => resolve(answer); });
    }
    if (path === "/api/cohorts/teams") {
      return Response.json([{
        id: TEAM_ID, name: TEAM_NAME, description: null, provenance: "live",
        repo: { fullName: "octo/face-finder", url: "https://github.com/octo/face-finder" },
        members: [{ login: "teammate", name: null, avatarUrl: null, role: "admin" }],
        adminLogin: "teammate",
      }]);
    }
    if (path === "/api/team/join") {
      // The server's own rule: one team at a time, so a membership made
      // elsewhere refuses this join and writes nothing.
      if (onTeam !== false) {
        return Response.json({ error: { code: "already_on_team", message: "You are already on a team." } }, { status: 409 });
      }
      joinWrites += 1;
      onTeam = true;
      return Response.json(teamDetail(options.members, options.teammateLogin));
    }
    if (path === "/api/github/repositories") return new Promise<Response>(() => {});
    return Response.json({ error: { code: "not_found", message: "Not here." } }, { status: 404 });
  };
  return {
    fetch, leaves, release: () => release(),
    /** Another team's join, landed on the server (the Connect page's own join
     *  flow is covered in connect-wizard.test.ts). */
    joinOther: () => { onTeam = "other"; },
    /** Joining the same team again, as a GitHub collaborator can. */
    rejoin: () => { onTeam = true; },
    holdNextSession: () => { sessionMode = "hold-next"; },
    releaseSession: () => releaseSession(),
    failSessions: () => { sessionMode = "fail"; },
    goOffline: () => { sessionMode = "offline"; },
    joinWrites: () => joinWrites,
    team: () => onTeam,
  };
}

async function mount(t: TestContext, options: { members: number; alreadyLeft?: boolean; holdLeave?: boolean; teammateLogin?: string; archive?: boolean }) {
  const server = portal(options);
  const window = new Window({ url: "https://portal.example/team" });
  const globals: Record<string, unknown> = {
    window, document: window.document, navigator: window.navigator,
    HTMLElement: window.HTMLElement, Element: window.Element, SVGElement: window.SVGElement,
    sessionStorage: window.sessionStorage, localStorage: window.localStorage,
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
    // Reduced motion, so /connect draws without its entrance: Happy DOM
    // rejects the animation Motion cancels when the test unmounts it.
    matchMedia: (query: string) => ({
      matches: query === "(prefers-reduced-motion)",
      media: query,
      addEventListener() {},
      removeEventListener() {},
    }),
    fetch: server.fetch,
    React, IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  Object.defineProperty(window, "matchMedia", { configurable: true, value: globals.matchMedia });
  const container = window.document.createElement("div");
  window.document.body.append(container);
  // SAFETY: Happy DOM implements the Element operations React DOM uses.
  const root = createRoot(container as unknown as Element);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
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

  // Imported after the globals exist: Motion decides at module load whether
  // it is running in a browser.
  const { RequireStage } = await import("../src/App.tsx");
  const { TeamPage } = await import("../src/routes/TeamPage.tsx");
  const { ConnectPage } = await import("../src/routes/ConnectPage.tsx");
  let path = "";
  const visited: string[] = [];
  function Where() {
    path = useLocation().pathname;
    if (visited.at(-1) !== path) visited.push(path);
    return null;
  }
  const guarded = (stage: "cohort" | "team", page: React.ComponentType) =>
    React.createElement(RequireStage, { stage }, React.createElement(page));
  await act(async () => root.render(
    React.createElement(QueryClientProvider, { client },
      React.createElement(MemoryRouter, { initialEntries: ["/team"] },
        React.createElement(Where),
        React.createElement(Routes, null,
          React.createElement(Route, { path: "/team", element: guarded("team", TeamPage) }),
          React.createElement(Route, { path: "/connect", element: guarded("cohort", ConnectPage) }),
          React.createElement(Route, { path: "/dashboard", element: guarded("team", () => React.createElement("p", null, "The team's runs")) }),
        ),
      ),
    ),
  ));
  await flush();
  return { container, server, client, flush, path: () => path, visited };
}

async function pressLeaveTwice(container: HTMLElement, flush: () => Promise<void>) {
  const leave = [...container.querySelectorAll("button")].find((button) => button.textContent?.startsWith("Leave"));
  assert.ok(leave, "no Leave on the student's own row");
  await act(async () => leave.click());
  await flush();
  assert.match(leave.textContent ?? "", /^Confirm, you leave/);
  await act(async () => leave.click());
  await flush();
}

test("leaving lands on the team choice and says which team, through the stage guard", async (t) => {
  const { container, server, flush, path } = await mount(t, { members: 2 });

  // Only the student's own row offers Leave; the teammate's has no control.
  const rows = [...container.querySelectorAll("li")].filter((row) => /student|teammate/.test(row.textContent ?? ""));
  assert.equal(rows.filter((row) => /Leave/.test(row.textContent ?? "")).length, 1);

  await pressLeaveTwice(container, flush);

  assert.deepEqual(server.leaves, [{ teamId: TEAM_ID }]);
  assert.equal(path(), "/connect");
  const notice = [...container.querySelectorAll('[role="status"]')].find((node) => /left/.test(node.textContent ?? ""));
  assert.equal(
    notice?.textContent,
    `You left ${TEAM_NAME}Its runs and results stay with the team. If GitHub still gives you write access to its repository, you can join it again below.`,
  );
});

test("the armed Leave says what stays, and the last member hears the team stays joinable", async (t) => {
  const { container, flush } = await mount(t, { members: 1 });
  const leave = [...container.querySelectorAll("button")].find((button) => button.textContent?.startsWith("Leave"));
  assert.ok(leave);
  assert.equal(container.querySelector("li [role=status]"), null, "the consequence shows only while armed");
  await act(async () => leave.click());
  await flush();
  assert.equal(
    container.querySelector("li [role=status]")?.textContent,
    "You're the last member, so the team will be empty. It keeps its repository, runs and results, and anyone with write access on GitHub can join it again.",
  );
});

test("a leave another tab already made is reported as such, not as a fresh one", async (t) => {
  const { container, flush } = await mount(t, { members: 2, alreadyLeft: true });
  await pressLeaveTwice(container, flush);
  const notice = [...container.querySelectorAll('[role="status"]')].find((node) => /left/.test(node.textContent ?? ""));
  assert.match(notice?.textContent ?? "", /^You'd already left Vision Squad/);
});

test("a refetch that reaches /connect before the leave answers still shows the notice", async (t) => {
  const { container, server, client, flush, path } = await mount(t, { members: 2, holdLeave: true });
  await pressLeaveTwice(container, flush);
  // Any refetch now sees the committed leave and the guard redirects first.
  await act(async () => { await client.invalidateQueries(); });
  // The guard's redirect can land a tick after act returns, so wait for the
  // state itself: on /connect with the team choice drawn.
  const choiceDrawn = () => path() === "/connect" && !/Checking the cohort/.test(container.textContent ?? "");
  for (let i = 0; i < 50 && !choiceDrawn(); i += 1) await flush();
  assert.equal(path(), "/connect");
  assert.doesNotMatch(container.textContent ?? "", /Checking the cohort/, "the team choice must be drawn before the leave answers");
  const leftNotice = () => [...container.querySelectorAll('[role="status"]')].find((node) => /left/.test(node.textContent ?? ""));
  assert.equal(leftNotice(), undefined, "nothing to say until the leave has answered");
  await act(async () => server.release());
  await flush();
  assert.match(leftNotice()?.textContent ?? "", /^You left Vision Squad/);
});

test("when a teammate shows the same login, only the reader's own row offers Leave", async (t) => {
  // Two accounts can display one login (a development account beside a GitHub
  // one); the row is chosen by the server's isYou, not by comparing logins.
  const { container, flush } = await mount(t, { members: 2, teammateLogin: "student" });
  const rows = [...container.querySelectorAll("li")].filter((row) => /student/.test(row.textContent ?? ""));
  assert.equal(rows.length, 2);
  const withLeave = rows.filter((row) => [...row.querySelectorAll("button")].some((b) => b.textContent?.startsWith("Leave")));
  assert.equal(withLeave.length, 1, "Leave appeared on more than the reader's row");
  const saysYou = (row: Element) => [...row.querySelectorAll("span")].some((span) => span.textContent === "you");
  assert.ok(saysYou(withLeave[0]), "the row with Leave is not the one marked as the reader");
  assert.equal(rows.filter(saysYou).length, 1, "more than one row says you");
  const leave = [...withLeave[0].querySelectorAll("button")].find((b) => b.textContent?.startsWith("Leave"))!;
  await act(async () => leave.click());
  await flush();
  assert.equal(container.querySelectorAll("li [role=status]").length, 1, "the consequence showed under more than one row");
});

test("a leave that answers after the student joined another team leaves that team alone", async (t) => {
  // The delete commits, a refetch takes the student to /connect, they join
  // another team, and only then does the old leave answer. Acting on it would
  // empty the new team from the session and send them back to /connect.
  const { container, server, client, flush, path, visited } = await mount(t, { members: 2, holdLeave: true });
  const { peekLeftTeam } = await import("../src/lib/left-team.ts");
  await pressLeaveTwice(container, flush);
  await act(async () => { await client.invalidateQueries(); });
  for (let i = 0; i < 50 && path() !== "/connect"; i += 1) await flush();
  assert.equal(path(), "/connect");

  server.joinOther();
  await act(async () => { await client.invalidateQueries({ queryKey: ["session"] }); });
  for (let i = 0; i < 50 && path() !== "/dashboard"; i += 1) await flush();
  assert.equal(path(), "/dashboard", "joining did not reach the new team's page");

  const before = visited.length;
  await act(async () => server.release());
  await flush();
  assert.deepEqual(visited.slice(before), [], "the old leave moved the student off the team they joined");
  assert.equal(path(), "/dashboard");
  const session = client.getQueryData<{ team: { id: string } | null }>(["session"]);
  assert.equal(session?.team?.id, OTHER_TEAM_ID, "the old leave emptied the new team from the session");
  assert.equal(peekLeftTeam(), null, "a notice about the old team was queued for a later visit");
  assert.match(container.textContent ?? "", /The team's runs/);
});

test("a leave that answers after the student rejoined the same team leaves that membership alone", async (t) => {
  // As above, but the student joins the team they just left. Comparing team
  // ids cannot tell this apart from a leave still in progress; a session read
  // made after the leave was sent and showing a team can.
  const { container, server, client, flush, path, visited } = await mount(t, { members: 2, holdLeave: true });
  const { peekLeftTeam } = await import("../src/lib/left-team.ts");
  await pressLeaveTwice(container, flush);
  await act(async () => { await client.invalidateQueries(); });
  for (let i = 0; i < 50 && path() !== "/connect"; i += 1) await flush();
  assert.equal(path(), "/connect");

  server.rejoin();
  await act(async () => { await client.invalidateQueries({ queryKey: ["session"] }); });
  for (let i = 0; i < 50 && path() !== "/dashboard"; i += 1) await flush();
  assert.equal(path(), "/dashboard", "rejoining did not reach the team's page");

  const before = visited.length;
  await act(async () => server.release());
  await flush();
  assert.deepEqual(visited.slice(before), [], "the old leave moved the student off the team they rejoined");
  const session = client.getQueryData<{ team: { id: string } | null }>(["session"]);
  assert.equal(session?.team?.id, TEAM_ID, "the old leave emptied the rejoined team from the session");
  assert.equal(peekLeftTeam(), null, "a 'You left' notice was queued for a team they are on");
});

test("a session read answered before the delete does not stop the leave from landing", async (t) => {
  // A read of the old team, sent before the delete and answered after the
  // leave was sent, once made a late reply look like a newer membership. The
  // reply now reads the session afresh, after the delete it confirms.
  const { container, server, client, flush, path } = await mount(t, { members: 2, holdLeave: true });
  server.holdNextSession();
  await act(async () => { void client.invalidateQueries({ queryKey: ["session"] }); });
  await flush();
  await pressLeaveTwice(container, flush);
  server.releaseSession();
  await flush();
  assert.equal(path(), "/team", "the pre-delete read still shows the team");
  await act(async () => server.release());
  const choiceDrawn = () => path() === "/connect" && !/Checking the cohort/.test(container.textContent ?? "");
  for (let i = 0; i < 50 && !choiceDrawn(); i += 1) await flush();
  assert.equal(path(), "/connect");
  const notice = [...container.querySelectorAll('[role="status"]')].find((node) => /left/.test(node.textContent ?? ""));
  assert.match(notice?.textContent ?? "", /^You left Vision Squad/);
});

test("a leave whose follow-up session read fails says so on the Team page, with a reload", async (t) => {
  const { container, server, flush, path } = await mount(t, { members: 2, holdLeave: true });
  await pressLeaveTwice(container, flush);
  server.failSessions();
  await act(async () => server.release());
  await flush();
  assert.equal(path(), "/team");
  const alert = container.querySelector('[role="alert"]');
  assert.match(alert?.textContent ?? "", /You left Vision Squad, but the page couldn't refresh to show where you are now\. Reload it\./);
  assert.ok([...(alert?.querySelectorAll("button") ?? [])].some((b) => b.textContent === "Reload page"));
});

test("a leave whose follow-up read happens offline still reaches the reload", async (t) => {
  // The delete commits, then the browser goes offline before the session is
  // read again. A read that waits for the network never ends; this one fails.
  const { container, server, flush, path } = await mount(t, { members: 2, holdLeave: true });
  await pressLeaveTwice(container, flush);
  onlineManager.setOnline(false);
  t.after(() => onlineManager.setOnline(true));
  server.goOffline();
  await act(async () => server.release());
  await flush();
  assert.equal(path(), "/team");
  const alert = container.querySelector('[role="alert"]');
  assert.match(alert?.textContent ?? "", /You left Vision Squad, but the page couldn't refresh/);
  assert.ok([...(alert?.querySelectorAll("button") ?? [])].some((b) => b.textContent === "Reload page"));
});

test("a join elsewhere between the post-leave read and its answer is reached from Connect, not overwritten", async (t) => {
  // The read after the leave sees no team; before its answer lands another
  // window joins team B. No further read can rule that out, so the page lands
  // on /connect believing there is no team. Joining from there is refused by
  // the server, and the refusal offers a full load of the student's team.
  const { container, server, flush, path } = await mount(t, { members: 2, holdLeave: true });
  await pressLeaveTwice(container, flush);
  server.holdNextSession();
  await act(async () => server.release());
  await flush();
  server.joinOther();
  await act(async () => server.releaseSession());
  const choiceDrawn = () => path() === "/connect" && !/Checking the cohort/.test(container.textContent ?? "");
  for (let i = 0; i < 50 && !choiceDrawn(); i += 1) await flush();
  assert.equal(path(), "/connect");

  const toJoin = [...container.querySelectorAll("button")].find((b) => b.textContent?.startsWith("Join a team"));
  assert.ok(toJoin, "no way to the join list");
  await act(async () => toJoin.click());
  await flush();
  const join = container.querySelector<HTMLButtonElement>(`button[aria-label="Join ${TEAM_NAME}"]`);
  assert.ok(join);
  await act(async () => join.click());
  await flush();

  const alert = [...container.querySelectorAll('[role="alert"]')].find((node) => /already on a team/.test(node.textContent ?? ""));
  const open = [...(alert?.querySelectorAll("a") ?? [])].find((a) => a.textContent === "Open your current team");
  assert.equal(open?.getAttribute("href"), "/team", "no way from the refusal to the team the student is on");
  assert.equal(server.joinWrites(), 0, "the refused join wrote a membership");
  assert.equal(server.team(), "other", "team B's membership changed");
});

test("the last member of a past-course team hears that only staff can add anyone back", async (t) => {
  // Students can't join an archive team themselves (routes/team-membership.ts);
  // staff can add anyone to it (routes/admin.ts). Leaving is still allowed.
  const { container, flush } = await mount(t, { members: 1, archive: true });
  const leave = [...container.querySelectorAll("button")].find((button) => button.textContent?.startsWith("Leave"));
  assert.ok(leave, "an archive team's member had no way to leave");
  await act(async () => leave.click());
  await flush();
  const line = container.querySelector("li [role=status]")?.textContent ?? "";
  assert.equal(
    line,
    "You're the last member, so the team will be empty. It keeps its runs and results, and your GitHub access doesn't change. It's a past-course demonstration, so only course staff can add anyone back.",
  );
  assert.doesNotMatch(line, /can join it again/);
});

test("leaving a past-course team lands without promising a way back in", async (t) => {
  const { container, flush, path } = await mount(t, { members: 2, archive: true });
  const leave = [...container.querySelectorAll("button")].find((button) => button.textContent?.startsWith("Leave"));
  await act(async () => leave!.click());
  await flush();
  assert.equal(
    container.querySelector("li [role=status]")?.textContent,
    "Only you come off the team; its hosted runs, attempts and published results stay, and your GitHub access doesn't change. It's a past-course demonstration, so you can't join it again yourself; course staff would have to add you back.",
  );
  await act(async () => leave!.click());
  const choiceDrawn = () => path() === "/connect" && !/Checking the cohort/.test(container.textContent ?? "");
  for (let i = 0; i < 50 && !choiceDrawn(); i += 1) await flush();
  const notice = [...container.querySelectorAll('[role="status"]')].find((node) => /left/.test(node.textContent ?? ""));
  assert.equal(
    notice?.textContent,
    `You left ${TEAM_NAME}Its runs and results stay with the team. It's a past-course demonstration, so only course staff can add you back.`,
  );
});
