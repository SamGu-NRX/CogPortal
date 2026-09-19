import assert from "node:assert/strict";
import test from "node:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { StaticRouter } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

(globalThis as typeof globalThis & { React: typeof React }).React = React;

import { RequireStage, RequireStaff } from "../src/App.tsx";
import { SignInPage } from "../src/routes/SignInPage.tsx";
import { ApiRequestError } from "../src/lib/api.ts";

/**
 * B-03 and B-13: a session read that has failed must render the standard
 * QueryError treatment, not an infinite LoadingMark (guards) or the disabled
 * "isn't configured" button (sign-in). The session query is seeded directly
 * into a QueryClient cache, because the failure being asserted is a *settled*
 * error after retry, and the static renderer never runs effects that could
 * refetch.
 */

const NETWORK_DOWN = new ApiRequestError(
  "network",
  "The request never reached the portal.",
  0,
);

/** The smallest session the guards' checks read. */
const SIGNED_IN_SESSION = {
  user: {
    login: "octocat",
    name: null,
    avatarUrl: null,
    platformRole: "student",
    isOwner: false,
    isTa: false,
  },
  cohort: { slug: "bwsi", name: "BWSI" },
  team: { id: "team_1", name: "Team One", description: null, repo: null },
  auth: {
    githubConfigured: true,
    devAuthEnabled: false,
    onboardingDevToolsEnabled: false,
    appSlug: null,
    templateRepo: null,
    executionProvider: "fixture",
  },
};

function clientWithSession(state: {
  data?: unknown;
  error?: unknown;
}): QueryClient {
  // retryOnMount must be off: a static render only ever "mounts", and a
  // mounting observer over an errored entry optimistically reports pending
  // because it is about to refetch. In the browser the query fails while
  // mounted and settles at error; this models that settled state.
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, retryOnMount: false } },
  });
  if (state.data !== undefined) {
    client.setQueryData(["session"], state.data);
  }
  const query = client.getQueryCache().build(client, {
    queryKey: ["session"],
  });
  if (state.error !== undefined) {
    query.setState({
      status: "error",
      error: state.error as Error,
      errorUpdatedAt: Date.now(),
      errorUpdateCount: 1,
      fetchStatus: "idle",
    });
  }
  return client;
}

function render(
  client: QueryClient,
  element: React.ReactElement,
  location = "/dashboard",
): string {
  return renderToStaticMarkup(
    React.createElement(
      QueryClientProvider,
      { client },
      React.createElement(
        StaticRouter as never,
        { location } as never,
        element,
      ),
    ),
  );
}

const CHILD = React.createElement("p", null, "guarded content");

test("a cold session failure in RequireStage renders the error panel with retry, not a loading mark", () => {
  const html = render(
    clientWithSession({ error: NETWORK_DOWN }),
    React.createElement(RequireStage, { stage: "team" }, CHILD),
  );

  assert.match(html, /REQUEST DID NOT ARRIVE/);
  assert.match(html, /Try again<\/button>/);
  assert.doesNotMatch(html, /Loading…/);
  assert.doesNotMatch(html, /guarded content/);
});

test("a cold session failure in RequireStaff renders the error panel, not a loading mark", () => {
  const html = render(
    clientWithSession({ error: NETWORK_DOWN }),
    React.createElement(RequireStaff, null, CHILD),
    "/admin",
  );

  assert.match(html, /REQUEST DID NOT ARRIVE/);
  assert.doesNotMatch(html, /Loading…/);
});

test("a warm tab keeps working off the cached session when a refetch fails", () => {
  // The bug report's nuance: with cached data the guards must not replace a
  // working page with the panel just because a background refresh failed.
  const html = render(
    clientWithSession({ data: SIGNED_IN_SESSION, error: NETWORK_DOWN }),
    React.createElement(RequireStage, { stage: "team" }, CHILD),
  );

  assert.match(html, /guarded content/);
  assert.doesNotMatch(html, /REQUEST DID NOT ARRIVE/);
});

test("a genuinely pending session still renders the loading mark", () => {
  const html = render(
    clientWithSession({}),
    React.createElement(RequireStage, { stage: "team" }, CHILD),
  );

  assert.match(html, /Loading…/);
  assert.doesNotMatch(html, /Try again/);
});

test("a session outage on the sign-in page renders the error panel, not disabled authentication", () => {
  const html = render(
    clientWithSession({ error: NETWORK_DOWN }),
    React.createElement(SignInPage),
    "/signin",
  );

  assert.match(html, /REQUEST DID NOT ARRIVE/);
  assert.match(html, /Try again<\/button>/);
  assert.doesNotMatch(html, /isn't configured/);
  assert.doesNotMatch(html, /Continue with GitHub/);
});

test("an unconfigured provider explains itself in visible text, not a hover title", () => {
  const html = render(
    clientWithSession({
      data: {
        ...SIGNED_IN_SESSION,
        user: null,
        auth: { ...SIGNED_IN_SESSION.auth, githubConfigured: false },
      },
    }),
    React.createElement(SignInPage),
    "/signin",
  );

  assert.match(html, /GitHub sign-in isn&#x27;t configured/);
  assert.doesNotMatch(html, /title="GitHub sign-in/);
});
