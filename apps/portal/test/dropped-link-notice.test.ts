import assert from "node:assert/strict";
import test from "node:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DroppedLinkNotice } from "../src/components/DroppedLinkNotice.tsx";
import { rememberDroppedDeviceLink } from "../src/lib/pending-return.ts";
import { setupCommandLines } from "../src/lib/setup-progress.ts";

(globalThis as typeof globalThis & { React: typeof React }).React = React;

test("dropped device approval retries the current portal before or after a prior device link", () => {
  const oldWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const oldStorage = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage");
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, "sessionStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
      removeItem: (key: string) => { values.delete(key); },
    },
  });
  try {
    for (const origin of ["https://portal.example", "http://localhost:5179"]) {
      Object.defineProperty(globalThis, "window", { configurable: true, value: { location: { origin } } });
      const expected = `cogworks link --portal ${origin}`;
      for (const deviceLinked of [false, true]) {
        const setupLink = setupCommandLines({
          cloneUrl: "https://github.com/course/team.git", repoName: "team",
          benchmarkId: "language-search", benchmarkTitle: "Semantic Image Search",
          portalOrigin: origin, verified: () => false, deviceLinked,
        }).find((command) => command.id === "link");
        assert.equal(setupLink?.command, expected);
        assert.equal(setupLink?.verified, deviceLinked);
      }
      rememberDroppedDeviceLink("/connections?user_code=TEST-CODE");
      const device = renderToStaticMarkup(React.createElement(DroppedLinkNotice));
      assert.match(device, /role="status"/);
      assert.ok(device.includes(expected));
      assert.match(device, /\[overflow-wrap:anywhere\]/);
      assert.equal(renderToStaticMarkup(React.createElement(DroppedLinkNotice)), "", "notice is consumed once");

      rememberDroppedDeviceLink("/connections#discord=test-state");
      const discord = renderToStaticMarkup(React.createElement(DroppedLinkNotice));
      assert.match(discord, /start the link again from Discord/);
      assert.doesNotMatch(discord, /cogworks link/);
    }
  } finally {
    if (oldWindow) Object.defineProperty(globalThis, "window", oldWindow);
    else Reflect.deleteProperty(globalThis, "window");
    if (oldStorage) Object.defineProperty(globalThis, "sessionStorage", oldStorage);
    else Reflect.deleteProperty(globalThis, "sessionStorage");
  }
});
