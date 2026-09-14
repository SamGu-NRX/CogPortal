import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import * as React from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import { Code } from "../src/components/Code.tsx";
import { CopyBlock } from "../src/components/CopyBlock.tsx";

const LONG =
  'python -m pip install --upgrade --force-reinstall "cogworks-benchmark @ ' +
  'git+https://github.com/SamGu-NRX/CogPortal.git@094a6f1ac109716014492a57a81157e71b70f7ab#subdirectory=python/cogbench"';
const TOKEN =
  `python -c "import http.client as h; c = h.HTTPSConnection('portal.example'); ` +
  `c.request('POST', '/api/setup/check-off/abc'); print(c.getresponse().read().decode())"`;

const coloured = (container: Container) =>
  [...container.querySelectorAll("span[style]")]
    .map((node) => node.getAttribute("style") ?? "")
    .filter((style) => /color:/.test(style));

type Container = ReturnType<Window["document"]["createElement"]>;

/** Drives React until the DOM says the work is done, rather than guessing how
 *  long the dynamic import takes. Bounded so a genuine failure still fails. */
async function settle(until: () => boolean, what: string) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (until()) return;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
  assert.fail(`the DOM never reached: ${what}`);
}

const isHighlighted = (container: Container) => coloured(container).length > 0;

async function mount(t: TestContext, element: React.ReactNode, until?: (container: Container) => boolean) {
  const window = new Window({ url: "https://portal.example" });
  const writes: string[] = [];
  let reject = false;
  Object.defineProperty(window.navigator, "clipboard", {
    configurable: true,
    value: { writeText: async (value: string) => { if (reject) throw new Error("denied"); writes.push(value); } },
  });
  const globals = {
    window, document: window.document, navigator: window.navigator,
    HTMLElement: window.HTMLElement, React, IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  const container = window.document.createElement("div");
  window.document.body.append(container);
  // SAFETY: Happy DOM implements the Element operations React uses.
  const root = createRoot(container as unknown as Element);
  t.after(async () => {
    await act(async () => root.unmount());
    await window.happyDOM.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  });
  await act(async () => root.render(element));
  if (until) await settle(() => until(container), "the first render to settle");
  return {
    window, container, writes,
    rerender: async (next: React.ReactNode, ready?: (container: Container) => boolean) => {
      await act(async () => root.render(next));
      if (ready) await settle(() => ready(container), "the re-render to settle");
    },
    failNext: () => { reject = true; },
    allowNext: () => { reject = false; },
  };
}

test("a shell command is highlighted, and the visible text is exactly the command", async (t) => {
  const { container } = await mount(t, React.createElement(Code, { code: LONG, lang: "bash", wrap: true }), isHighlighted);
  const pre = container.querySelector("pre");
  assert.ok(pre, "no code body rendered");
  assert.equal(pre.textContent, LONG, "the visible text drifted from the command");
  const colours = coloured(container);
  assert.ok(colours.length > 1, `expected theme colours, saw ${colours.length}`);
  // The theme's own ink, not a browser default or a Shiki fallback palette.
  assert.ok(colours.some((style) => /#2e6b4f/i.test(style)), "the string colour is not the paper theme's");
});

test("the copied string is the command, not the markup around it", async (t) => {
  const { container, writes } = await mount(t, React.createElement(Code, { code: LONG, lang: "bash" }), isHighlighted);
  const button = container.querySelector("button");
  assert.ok(button);
  await act(async () => button.click());
  assert.deepEqual(writes, [LONG]);
  assert.ok(!writes[0].includes("<span"), "markup leaked into the clipboard");
});

test("a command with HTML characters is escaped on screen and copied literally", async (t) => {
  const tricky = `echo "<script>&</script>" > /tmp/x && cat <<'EOF'`;
  const { container, writes } = await mount(t, React.createElement(CopyBlock, { text: tricky }), isHighlighted);
  assert.equal(container.querySelector("div[tabindex]")?.textContent, tricky);
  assert.equal(container.querySelectorAll("script").length, 0, "a script element reached the DOM");
  const button = container.querySelector("button");
  await act(async () => button?.click());
  assert.deepEqual(writes, [tricky]);
});

test("CopyBlock keeps its own styling hooks and gains no second tab stop", async (t) => {
  const { container } = await mount(t, React.createElement(CopyBlock, { text: LONG }), isHighlighted);
  const box = container.querySelector("div[tabindex]");
  assert.ok(box, "the scrolling box lost its tab stop");
  assert.equal(box.getAttribute("tabindex"), "0");
  assert.match(box.getAttribute("class") ?? "", /text-\[12\.5px\]/);
  // Class presence only, not computed layout: it pins the intended styling,
  // and the browser pass is what confirms the rendered metrics.
  assert.match(box.getAttribute("class") ?? "", /\[&_pre\]:m-0/, "Shiki's wrapper is not held to this block's styling");
  // Shiki makes its own pre focusable by default; inside this box it must not.
  assert.equal(container.querySelector("pre")?.getAttribute("tabindex"), null);
  assert.equal(container.querySelectorAll("[tabindex]").length, 1);
});

test("a wrapped CopyBlock still takes no tab stop at all", async (t) => {
  const { container } = await mount(t, React.createElement(CopyBlock, { text: LONG, wrap: true }), isHighlighted);
  assert.equal(container.querySelectorAll("[tabindex]").length, 0, "wrapping introduced a tab stop");
  assert.equal(container.textContent?.includes(LONG), true);
});

test("Code keeps the focusable pre its scrolling block has always had", async (t) => {
  const { container } = await mount(t, React.createElement(Code, { code: LONG, lang: "bash" }), isHighlighted);
  assert.equal(container.querySelector("pre")?.getAttribute("tabindex"), "0");
});

test("a plain block opts out even after another block has highlighted", async (t) => {
  const { container } = await mount(t, React.createElement(
    "div", null,
    React.createElement(Code, { code: LONG, lang: "bash" }),
    React.createElement(CopyBlock, { text: TOKEN, lang: "text" }),
  ), isHighlighted);
  // The highlighter is loaded and working, so opting out is a decision.
  assert.ok(coloured(container).length > 1, "the neighbouring block never highlighted");
  // Scoped to the opted-out block: the highlighted one has a `code` of its own.
  const plain = container.querySelector("div[tabindex] > code");
  assert.ok(plain, "the plain block lost its code element");
  assert.equal(plain.textContent, TOKEN);
  assert.equal(plain.querySelectorAll("span[style]").length, 0, "the signed token was coloured");
  assert.equal(container.querySelectorAll("div[tabindex] pre").length, 0, "the plain block rendered a Shiki wrapper");
});

test("changing the code or the language never shows the older string", async (t) => {
  const first = "cogworks check --benchmark audio-identification";
  const second = "cogworks run --benchmark language-search --live";
  const view = await mount(t, React.createElement(Code, { code: first, lang: "bash" }),
    (c) => c.querySelector("pre")?.textContent === first && isHighlighted(c));
  assert.equal(view.container.querySelector("pre")?.textContent, first);

  await view.rerender(React.createElement(Code, { code: second, lang: "bash" }),
    (c) => c.querySelector("pre")?.textContent === second && isHighlighted(c));
  assert.equal(view.container.querySelector("pre")?.textContent, second);
  assert.equal(view.container.textContent?.includes(first), false, "the previous command survived the change");

  // Copying after the change writes the current string, not the rendered one.
  const button = view.container.querySelector("button");
  await act(async () => button?.click());
  assert.deepEqual(view.writes, [second]);

  // Switching to plain drops the highlighting rather than keeping stale markup.
  await view.rerender(React.createElement(Code, { code: second, lang: "text" }),
    (c) => coloured(c).length === 0);
  assert.equal(view.container.querySelector("pre")?.textContent, second);
  assert.equal(coloured(view.container).length, 0, "plain kept the previous highlighting");
});

for (const component of ["Code", "CopyBlock"] as const) {
  test(`${component} preserves spaces, tabs and newlines on screen and in the clipboard`, async (t) => {
    const command = "  python -c 'print(\"a  b\")'\n\tprintf 'done'  \n";
    const element = component === "Code"
      ? React.createElement(Code, { code: command, lang: "bash", wrap: true })
      : React.createElement(CopyBlock, { text: command, wrap: true });
    const { container, writes } = await mount(t, element, isHighlighted);
    assert.equal(container.querySelector("pre")?.textContent, command);
    const button = container.querySelector("button");
    assert.ok(button);
    await act(async () => button.click());
    assert.deepEqual(writes, [command]);
  });
}

for (const [name, element] of [
  ["Code", React.createElement(Code, { code: LONG, lang: "bash" })],
  ["CopyBlock", React.createElement(CopyBlock, { text: LONG })],
] as const) {
  test(`${name} reports a refused copy and keeps focus on the button`, async (t) => {
    const view = await mount(t, element, isHighlighted);
    const button = view.container.querySelector("button");
    assert.ok(button);
    button.focus();
    view.failNext();
    await act(async () => button.click());
    assert.match(view.container.textContent ?? "", /Couldn't copy\./);
    assert.equal(view.window.document.activeElement, button, "focus left the control it was on");

    view.allowNext();
    await act(async () => button.click());
    assert.deepEqual(view.writes, [LONG]);
    assert.match(view.container.textContent ?? "", /Copied\./);
  });
}
