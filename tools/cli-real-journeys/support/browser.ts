import { mkdir } from "node:fs/promises";
import { chromium, type Browser, type BrowserContext } from "playwright-core";
import { env } from "./cli.ts";

// The device approval is a student act performed in the portal SPA: the CLI
// prints a verification URI, the student opens it, signs in on the SPA's
// development sign-in form, and presses the page's own "Approve device"
// button. These helpers drive that real DOM with Playwright's packaged
// Chromium — no HTTP helper stands in for the student. The browser records
// what it saw (screenshots under the results directory) so a failed run
// leaves evidence a human can read.

// The suite's stack runs the SPA locally on loopback with no OAuth; the
// SPA's development sign-in form (one login field) authenticates the browser
// the same dev way support/portal.ts devLogin authenticates HTTP helpers.

/** Diagnostics appended as the browser session progresses; a failed case copies these into its receipt. */
export const debug: string[] = [];

function pushDiagnostic(kind: string, detail: string): void {
  debug.push(`browser: ${kind} ${detail}`);
}

const chromeArgs = [
  "--no-sandbox",
  "--disable-dev-shm-usage",
  "--disable-gpu",
  "--disable-extensions",
];

async function launchBrowser(): Promise<Browser> {
  return chromium.launch({ headless: true, args: chromeArgs });
}

/** A fresh browser context with its owning browser; screenshots land under the results directory. */
async function newContext(): Promise<{ browser: Browser; context: BrowserContext }> {
  const browser = await launchBrowser();
  await mkdir(`${env("RESULTS_DIR")}/browser`, { recursive: true });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    reducedMotion: "reduce",
  });
  return { browser, context };
}

/** The SPA's development sign-in: fill the real form and press its Sign in button; resolve where the SPA landed. */
async function devSignIn(context: BrowserContext, browsableOrigin: string, login: string, shots: string): Promise<string> {
  const page = await context.newPage();
  await page.goto(`${browsableOrigin}/signin`);
  await page.waitForSelector("#dev-login", { state: "visible", timeout: 15_000 });
  await page.fill("#dev-login", login);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.waitForURL((signedIn) => !signedIn.pathname.endsWith("/signin"), { timeout: 15_000 });
  const signedInAt = page.url();
  await page.screenshot({ path: `${env("RESULTS_DIR")}/browser/${shots}dev-signin.png`, fullPage: true });
  pushDiagnostic("signed in as", `${login} at ${signedInAt}`);
  return signedInAt;
}

export interface DeviceApproval {
  url: string;
  shownCode: string | null;
  statusLine: string;
}

/** Open the verification URI the CLI printed, name the device in the page's own field, and approve it with the page's own button — once, with no retries. */
async function approveDevice(
  context: BrowserContext,
  verificationUri: string,
  deviceName: string,
  userCode: string,
  shots: string,
): Promise<DeviceApproval> {
  const page = await context.newPage();
  await page.goto(verificationUri);
  await page.waitForSelector("#device-name", { state: "visible", timeout: 15_000 });
  await page.screenshot({ path: `${env("RESULTS_DIR")}/browser/${shots}approval-page.png`, fullPage: true });
  const field = await page.locator("#device-name").getAttribute("value");
  pushDiagnostic("approval page", `code ${userCode}, device-name field prefilled ${field}`);
  // The page ships a default device name; a student replaces it with their
  // own. fill() clears and types, exactly as a keyboard would.
  await page.fill("#device-name", deviceName);
  const shownCode = await page
    .getByText(userCode, { exact: true })
    .first()
    .isVisible()
    .then((visible) => (visible ? userCode : null))
    .catch(() => null);
  await page.getByRole("button", { name: "Approve device", exact: true }).click();
  // The page's own contract: the request panel is replaced by a status line
  // saying it worked, and — because the CLI's URI carries return_to=setup —
  // the page promises to return the reader to Setup on its own (~900ms).
  const outcome = page.locator("[data-request-outcome]");
  await outcome.waitFor({ state: "visible", timeout: 15_000 });
  const statusLine = (await outcome.textContent()) ?? "";
  await page.waitForURL((arrived) => arrived.pathname.endsWith("/setup"), { timeout: 15_000 });
  const url = page.url();
  await page.screenshot({ path: `${env("RESULTS_DIR")}/browser/${shots}approved.png`, fullPage: true });
  pushDiagnostic("approved", `at ${url}: ${statusLine.slice(0, 120)}`);
  return { url, shownCode, statusLine };
}

/** A real-browser session on the portal SPA at the suite's browsable origin. */
export class BrowserSession {
  private constructor(
    private readonly browser: Browser,
    private readonly context: BrowserContext,
    private readonly browsableOrigin: string,
    private readonly shots: string,
  ) {}

  /** `label` prefixes this session's screenshots so cases do not overwrite each other's. */
  static async start(browsableOrigin: string, label = ""): Promise<BrowserSession> {
    const { browser, context } = await newContext();
    return new BrowserSession(browser, context, browsableOrigin, label ? `${label.replace(/[^a-z0-9-]+/gi, "-")}-` : "");
  }

  /** Sign in through the SPA's development sign-in form; returns where the SPA landed. */
  async devSignIn(login: string): Promise<string> {
    return devSignIn(this.context, this.browsableOrigin, login, this.shots);
  }

  /** Name and approve the pending device on the page the CLI printed, the way a student would. */
  async approveDevice(verificationUri: string, deviceName: string, userCode: string): Promise<DeviceApproval> {
    return approveDevice(this.context, verificationUri, deviceName, userCode, this.shots);
  }

  async close(): Promise<void> {
    // Close the browser, not just the context: a leaked chrome process holds
    // the run's event loop open and the journey would never finish.
    await this.browser.close();
  }
}
