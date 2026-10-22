import assert from "node:assert/strict";
import test from "node:test";
import * as React from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Window } from "happy-dom";
import type { TeamDetail } from "@cogworks/contracts/schema";
import { useTeam, useUpdateTeam } from "../src/lib/queries.ts";

const REPO = { owner: "demo", name: "face-finder", fullName: "demo/face-finder", url: "https://github.com/demo/face-finder", defaultBranch: "main" };

/**
 * A Worker that handles each PATCH /api/team the moment it arrives and
 * answers with the team as it stood then, but holds each answer until the
 * test releases it, so two saves can answer in the opposite order from the
 * one the Worker handled them in.
 */
function heldWorker() {
  const stored: TeamDetail = {
    id: "team_1", name: "Team One", description: null, provenance: "live", repo: REPO, members: [], tas: [], isAdmin: true,
  };
  const held: Array<() => void> = [];
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  const fetch = async (url: string, init?: RequestInit) => {
    if (url === "/api/team" && init?.method === "PATCH") {
      const { teamId: _teamId, ...change } = JSON.parse(String(init.body)) as Partial<TeamDetail> & { teamId: string };
      Object.assign(stored, change);
      const answer = structuredClone(stored);
      return new Promise<Response>((resolve) => held.push(() => resolve(json(answer))));
    }
    if (url === "/api/team") return json(structuredClone(stored));
    return new Promise<Response>(() => {});
  };
  return { stored, held, fetch };
}

test("a rename and a description save that answer out of order leave the cache matching the server", async (t) => {
  const worker = heldWorker();
  const window = new Window({ url: "https://portal.example/team" });
  const globals = {
    window, document: window.document, navigator: window.navigator,
    HTMLElement: window.HTMLElement, Element: window.Element, React, IS_REACT_ACT_ENVIRONMENT: true,
    fetch: worker.fetch,
  };
  const saved = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

  let rename: (name: string) => Promise<unknown> = async () => undefined;
  let describe: (description: string) => Promise<unknown> = async () => undefined;
  function Team() {
    const team = useTeam();
    const nameUpdate = useUpdateTeam();
    const descriptionUpdate = useUpdateTeam();
    rename = (name) => nameUpdate.mutateAsync({ teamId: "team_1", name });
    describe = (description) => descriptionUpdate.mutateAsync({ teamId: "team_1", description });
    return React.createElement("p", null, team.data ? `${team.data.name} | ${team.data.description ?? "(none)"}` : "loading");
  }

  const container = window.document.createElement("div");
  window.document.body.append(container);
  // SAFETY: Happy DOM implements the Element operations React uses, with separate TS interfaces.
  const root = createRoot(container as unknown as Element);
  t.after(async () => {
    await act(async () => root.unmount());
    client.clear();
    await window.happyDOM.close();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  });
  const shown = () => container.textContent;
  const settle = async () => {
    for (let i = 0; i < 20; i += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  };

  await act(async () => root.render(React.createElement(QueryClientProvider, { client }, React.createElement(Team))));
  await settle();
  assert.equal(shown(), "Team One | (none)");

  // The Worker handles the rename, then the description; the description's
  // answer reaches the page first, the rename's (which predates the
  // description) last.
  let renamed!: Promise<unknown>;
  let described!: Promise<unknown>;
  await act(async () => {
    renamed = rename("New Name");
    described = describe("A line about our approach.");
  });
  assert.equal(worker.held.length, 2);
  const [renameAnswer, descriptionAnswer] = worker.held;
  await act(async () => { descriptionAnswer(); await described; });
  await settle();
  await act(async () => { renameAnswer(); await renamed; });
  await settle();

  assert.equal(shown(), `${worker.stored.name} | ${worker.stored.description}`);
  assert.equal(shown(), "New Name | A line about our approach.");
});

test("a save with nothing else in flight applies its own answer without asking again", async (t) => {
  const worker = heldWorker();
  let reads = 0;
  const window = new Window({ url: "https://portal.example/team" });
  const globals = {
    window, document: window.document, navigator: window.navigator,
    HTMLElement: window.HTMLElement, Element: window.Element, React, IS_REACT_ACT_ENVIRONMENT: true,
    fetch: (url: string, init?: RequestInit) => {
      if (url === "/api/team" && (init?.method ?? "GET") === "GET") reads += 1;
      return worker.fetch(url, init);
    },
  };
  const saved = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 60_000 } } });
  let rename: (name: string) => Promise<unknown> = async () => undefined;
  function Team() {
    const team = useTeam();
    const nameUpdate = useUpdateTeam();
    rename = (name) => nameUpdate.mutateAsync({ teamId: "team_1", name });
    return React.createElement("p", null, team.data?.name ?? "loading");
  }
  const container = window.document.createElement("div");
  window.document.body.append(container);
  // SAFETY: Happy DOM implements the Element operations React uses, with separate TS interfaces.
  const root = createRoot(container as unknown as Element);
  t.after(async () => {
    await act(async () => root.unmount());
    client.clear();
    await window.happyDOM.close();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  });
  const settle = async () => {
    for (let i = 0; i < 20; i += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  };

  await act(async () => root.render(React.createElement(QueryClientProvider, { client }, React.createElement(Team))));
  await settle();
  assert.equal(reads, 1);
  let renamed!: Promise<unknown>;
  await act(async () => { renamed = rename("Solo Name"); });
  await act(async () => { worker.held[0](); await renamed; });
  await settle();
  assert.equal(container.textContent, "Solo Name");
  assert.equal(reads, 1, "a lone save trusts its own answer");
});
