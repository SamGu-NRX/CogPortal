import assert from "node:assert/strict";
import test from "node:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { RepoName } from "../src/components/RepoName.tsx";

// One correct answer: the full name survives intact, the only added break
// opportunity sits right after the slash, and nothing asks the browser to cut
// at any letter (`break-all` split "ux-all-failed" on the Runs page).
test("an owner/name breaks after the slash and nowhere eager", () => {
  const html = renderToStaticMarkup(React.createElement(RepoName, { fullName: "cogworks-demo/ux-all-failed" }));
  assert.equal(html, '<span class="[overflow-wrap:anywhere]">cogworks-demo/<wbr/>ux-all-failed</span>');
});

test("a name without a slash renders as is", () => {
  const html = renderToStaticMarkup(React.createElement(RepoName, { fullName: "standalone" }));
  assert.equal(html, '<span class="[overflow-wrap:anywhere]">standalone</span>');
});
