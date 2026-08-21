import assert from "node:assert/strict";
import test from "node:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { StaticRouter } from "react-router";

(globalThis as typeof globalThis & { React: typeof React }).React = React;

import { QueryError } from "../src/components/Feedback.tsx";
import { ApiRequestError } from "../src/lib/api.ts";

/**
 * The mapping itself is asserted in query-error-state.test.ts. These mount
 * the component, because two of the claims are about rendering rather than
 * about the mapping: that a not-found state emits no button element at all,
 * and that an error is announced. Both were invisible to a test of the
 * function alone.
 *
 * QueryError reaches lib/api through the "@/" alias, which tsx resolves only
 * when pointed at tsconfig.app.json; the portal test script sets
 * TSX_TSCONFIG_PATH for exactly this. Link needs a router, hence StaticRouter.
 */
function render(error: unknown, props: { retry?: () => void } = {}): string {
  return renderToStaticMarkup(
    React.createElement(
      StaticRouter as never,
      { location: "/dashboard" } as never,
      React.createElement(QueryError, { error, ...props }),
    ),
  );
}

test("a not-found state renders no retry control, even when the page passes one", () => {
  // Every one of the 13 call sites passes retry, including the ones that 404
  // most often. A "Try again" button on a 404 promises something it cannot do.
  const html = render(new ApiRequestError("not_found", "Run not found.", 404), {
    retry: () => {},
  });

  assert.doesNotMatch(html, /<button/);
  assert.doesNotMatch(html, /Try again/);
  assert.match(html, /no record at this address/);
});

test("a not-found state keeps a way out", () => {
  const html = render(new ApiRequestError("not_found", "Run not found.", 404), {
    retry: () => {},
  });

  assert.match(html, /href="\/"/);
  assert.match(html, /Back to start/);
});

test("a not-found state is not dressed as a fault", () => {
  const html = render(new ApiRequestError("not_found", "Run not found.", 404));

  // bg-detect-wash is Panel's alert tone. FailureCard uses it for a run that
  // actually failed; an absent record has not failed at anything.
  assert.doesNotMatch(html, /bg-detect-wash/);
  assert.doesNotMatch(html, /COULD NOT LOAD/);
});

test("an unreachable portal offers the retry that is the entire fix", () => {
  const html = render(new ApiRequestError("network", "unused", 0), {
    retry: () => {},
  });

  assert.match(html, /Try again<\/button>/);
  assert.match(html, /REQUEST DID NOT ARRIVE/);
  assert.match(html, /nothing was lost/);
});

test("a server fault is announced as an alert and shows detector red", () => {
  const html = render(
    new ApiRequestError("provider_unconfigured", "The request could not be completed.", 500),
    { retry: () => {} },
  );

  assert.match(html, /role="alert"/);
  assert.match(html, /bg-detect-wash/);
  assert.match(html, /Try again<\/button>/);
});

test("a non-fault state is announced politely rather than interrupting", () => {
  const html = render(new ApiRequestError("network", "unused", 0));

  assert.match(html, /role="status"/);
  assert.match(html, /aria-live="polite"/);
  assert.doesNotMatch(html, /role="alert"/);
});

test("a page's own link still wins over the mapping's default", () => {
  // RunDetailPage and DashboardPage pass a nearer destination than the front
  // page. The slot has to keep working without those pages changing.
  const html = renderToStaticMarkup(
    React.createElement(
      StaticRouter as never,
      { location: "/runs/run_1" } as never,
      React.createElement(
        QueryError,
        { error: new ApiRequestError("not_found", "Run not found.", 404), retry: () => {} },
        React.createElement("a", { href: "/dashboard" }, "Back to dashboard"),
      ),
    ),
  );

  assert.match(html, /Back to dashboard/);
  assert.doesNotMatch(html, /Back to start/);
  assert.doesNotMatch(html, /<button/);
});

test("an expired session sends the student to sign in without a retry", () => {
  const html = render(new ApiRequestError("unauthorized", "Sign in to continue.", 401), {
    retry: () => {},
  });

  assert.match(html, /SESSION ENDED/);
  assert.match(html, /href="\/signin"/);
  assert.doesNotMatch(html, /<button/);
});

test("a student without a team is sent to the step that creates one", () => {
  const html = render(
    new ApiRequestError("no_team", "Connect a repository to continue.", 403),
    { retry: () => {} },
  );

  assert.match(html, /TEAM REQUIRED/);
  assert.match(html, /href="\/connect"/);
  assert.doesNotMatch(html, /<button/);
});

test("no rendered state uses an em dash", () => {
  const codes = ["network", "not_found", "unauthorized", "no_team", "no_cohort", "forbidden", "unknown"] as const;

  for (const code of codes) {
    const html = render(new ApiRequestError(code, "Server sentence.", 500), {
      retry: () => {},
    });
    assert.ok(!html.includes("—"), `em dash rendered for ${code}`);
  }
});
