import assert from "node:assert/strict";
import test from "node:test";
import * as React from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Window } from "happy-dom";
import { SetupPage } from "../src/routes/SetupPage.tsx";

// The completion panel is the last thing a student reads on the setup page.
// A step they checked off from their own terminal is their report, not
// something the portal observed, so the panel may only say the portal
// verified everything when it did.

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

const SESSION = {
  user: { login: "alice", name: "alice", avatarUrl: null, platformRole: "student", isOwner: false, isTa: false },
  cohort: { slug: "bwsi-2026", name: "BWSI CogWorks 2026" },
  team: { id: "team_a", name: "A", description: null, provenance: "live", repo: null },
  auth: {
    githubConfigured: false,
    devAuthEnabled: true,
    onboardingDevToolsEnabled: false,
    appSlug: null,
    templateRepo: null,
    executionProvider: "fixture",
  },
};

const TEAM = {
  id: "team_a",
  name: "A",
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
};

async function renderComplete(t: test.TestContext, byHand: string[]) {
  const window = new Window({ url: "https://portal.example/setup" });
  const globals = {
    window, document: window.document, navigator: window.navigator,
    HTMLElement: window.HTMLElement, Element: window.Element, SVGElement: window.SVGElement,
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
    React, IS_REACT_ACT_ENVIRONMENT: true,
    fetch: () => Promise.reject(new Error("every answer is seeded")),
  };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }

  const scoped = ["environment", "project", "wiring"];
  const observed = (step: string) => !byHand.includes(step);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(["session"], SESSION);
  client.setQueryData(["team"], TEAM);
  client.setQueryData(["benchmarks"], [BENCHMARK]);
  client.setQueryData(["connections"], {
    github: null,
    discord: null,
    cliDevices: [{ id: "d1", name: "laptop", createdAt: 1, lastUsedAt: null }],
  });
  client.setQueryData(["setup-state", "alice", "team_a", BENCHMARK.id], {
    verified: observed("clone") ? ["clone"] : [],
    verifiedByBenchmark: { [BENCHMARK.id]: scoped.filter(observed) },
    checked: observed("clone") ? [] : ["clone"],
    checkedByBenchmark: { [BENCHMARK.id]: scoped.filter((step) => !observed(step)) },
    tokens: {},
  });

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
  await act(async () => root.render(
    React.createElement(QueryClientProvider, { client },
      React.createElement(MemoryRouter, null, React.createElement(SetupPage)),
    ),
  ));
  const panel = [...container.querySelectorAll("section")].find((section) => section.textContent?.includes("Setup complete"));
  assert.ok(panel, "the completion panel did not render");
  return { text: panel.textContent ?? "", verificationGreen: panel.classList.contains("bg-verify-wash") };
}

test("a setup the portal observed end to end says it checks out", async (t) => {
  const { text, verificationGreen } = await renderComplete(t, []);
  assert.match(text, /Everything the portal can verify checks out\./);
  assert.ok(verificationGreen);
});

test("a setup finished with check-offs does not claim the portal verified it", async (t) => {
  const { text, verificationGreen } = await renderComplete(t, ["clone", "environment"]);
  assert.doesNotMatch(text, /verify checks out/);
  assert.ok(!verificationGreen, "self-reported steps were coloured as verified");
  assert.match(text, /checked off are your own report rather than something the portal saw/);
});
