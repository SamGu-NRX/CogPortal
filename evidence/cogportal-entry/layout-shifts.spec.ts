import { spawn } from "node:child_process";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { SHIFT_OBSERVER_SCRIPT, heroCta, writeResults } from "./helpers";
// The same frozen fixture module the render tests parse: the stubbed
// session is the schema-validated signed-out state, not a hand-typed JSON.
import { SIGNED_OUT } from "../../apps/portal/test/fixtures/entry-states";

/**
 * Layout-shift evidence for the entry, measured against the PRODUCTION
 * client bundle (apps/portal/dist/client) — the artifact a student actually
 * loads. The dev server is not the arbiter: its on-demand module graph makes
 * font/CSS discovery late in a way the built page is not.
 *
 * Repeated cold loads (a fresh context each time, so no HTTP cache smooths
 * anything over) with a PerformanceObserver installed before the document
 * runs. The page loads with its fonts and animations exactly as shipped —
 * if a real shift exists, the fix belongs in the page, not here.
 */

const LOADS_PER_VIEWPORT = 3;
/** One origin per worker so the two projects never share a server. */
const BASE_PROD_PORT = 4188;

interface ProdPortal {
  origin: string;
  close: () => Promise<void>;
}

/** Serve the built bundle + the frozen signed-out session on a private port. */
async function startProdPortal(workerIndex: number): Promise<ProdPortal> {
  const staticRoot = join(process.cwd(), "apps", "portal", "dist", "client");
  try {
    await access(join(staticRoot, "index.html"));
  } catch {
    throw new Error(
      `No production bundle at ${staticRoot} — run \`pnpm --filter @cogworks/portal build\` first.`,
    );
  }
  const dir = await mkdtemp(join(tmpdir(), "cogportal-entry-evidence-"));
  const sessionFile = join(dir, "session.json");
  await writeFile(sessionFile, JSON.stringify(SIGNED_OUT));

  const port = BASE_PROD_PORT + workerIndex;
  const child = spawn(
    process.execPath,
    [
      join(process.cwd(), "evidence", "cogportal-entry", "prod-server.mjs"),
      `--static=${staticRoot}`,
      `--port=${port}`,
      `--session=${sessionFile}`,
    ],
    { stdio: "ignore" },
  );

  const origin = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 10_000;
  for (;;) {
    try {
      const res = await fetch(`${origin}/api/session`);
      if (res.ok) break;
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) {
      await close();
      throw new Error(`prod-server did not become ready on ${origin}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  async function close(): Promise<void> {
    child.kill();
    await rm(dir, { recursive: true, force: true });
  }
  return { origin, close };
}

let prodPortal: ProdPortal | undefined;

test.beforeAll(async ({}, testInfo) => {
  prodPortal = await startProdPortal(testInfo.workerIndex);
});

test.afterAll(async () => {
  await prodPortal?.close();
});

async function coldLoad(page: Page, origin: string): Promise<{ fontsRendered: Record<string, boolean> }> {
  await page.addInitScript(SHIFT_OBSERVER_SCRIPT);
  await page.goto(`${origin}/`);
  // Past the session read and the settle window a student would see.
  await heroCta(page).waitFor({ state: "visible" });
  await page.waitForTimeout(1_500);
  // Zero shifts is only meaningful if the course type actually rendered:
  // record that the webfonts are live (font-display: optional serves them
  // whenever they make the block window, which a local load always does).
  const fontsRendered = await page.evaluate(() => ({
    atkinsonNext: document.fonts.check('16px "Atkinson Hyperlegible Next Variable"'),
    sourceSerif4: document.fonts.check('16px "Source Serif 4 Variable"'),
    atkinsonMono: document.fonts.check('16px "Atkinson Hyperlegible Mono Variable"'),
  }));
  return { fontsRendered };
}

test("repeated loads produce zero layout shifts", async ({ browser }, testInfo) => {
  const origin = prodPortal?.origin;
  if (!origin) throw new Error("prod portal did not start");
  const runs: { load: number; shifts: number; details: unknown[] }[] = [];

  for (let load = 1; load <= LOADS_PER_VIEWPORT; load += 1) {
    const context = await browser.newContext();
    const page = await context.newPage();
    try {
      const { fontsRendered } = await coldLoad(page, origin);
      const shifts = await page.evaluate(
        () => (window as unknown as { __shifts: unknown[] }).__shifts,
      );
      // A dead observer would make "zero shifts" meaningless. This string is
      // injected as plain JS — if it stopped running, fail the load loudly
      // instead of writing a clean-looking number.
      if (!Array.isArray(shifts)) {
        throw new Error(
          "shift observer did not install — SHIFT_OBSERVER_SCRIPT must be plain JavaScript",
        );
      }
      runs.push({ load, shifts: shifts.length, details: shifts, fontsRendered });
    } finally {
      await context.close();
    }
  }

  writeResults(`layout-shifts-${testInfo.project.name}.json`, {
    project: testInfo.project.name,
    origin: "production bundle via evidence/cogportal-entry/prod-server.mjs",
    loads: LOADS_PER_VIEWPORT,
    note: "Fresh context per load (cold cache). Shift entries include sources; hadRecentInput excluded per the CLS definition.",
    runs,
  });

  const offending = runs.filter((r) => r.shifts > 0);
  expect(
    offending,
    `layout shifts observed on load(s) ${offending
      .map((r) => `#${r.load}: ${JSON.stringify(r.details)}`)
      .join("; ")} — fix the page, not this test`,
  ).toEqual([]);
});
