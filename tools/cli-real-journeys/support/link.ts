import { BrowserSession } from "./browser.ts";
import type { CliHome } from "./cli.ts";

/** The subset of a journey Case linking writes to. */
interface Judged {
  expect(condition: boolean, claim: string, evidence: string): void;
  claim(claim: string, evidence: string): void;
  command(args: string, exit: number | null, output: string): void;
}

/**
 * Links a CLI HOME the way a student does: `cogworks link --no-browser`
 * prints a verification URI and code, a real Chromium signs in on the SPA,
 * opens exactly that URI, names the device and presses the page's own
 * "Approve device" button once. There is no HTTP approval and no retry: a
 * failed approval fails the case.
 */
export async function linkThroughBrowser(
  case_: Judged,
  home: CliHome,
  options: { portalOrigin: string; browsableOrigin: string; deviceName: string; login?: string },
): Promise<void> {
  const link = home.start(["link", "--portal", options.portalOrigin, "--no-browser"]);
  const printed = await link.waitFor(/Open (\S+) and confirm code ([A-Za-z0-9-]+)/, 30_000);
  const [, verificationUri, userCode] = printed;
  const browser = await BrowserSession.start(options.browsableOrigin, options.deviceName);
  try {
    await browser.devSignIn(options.login ?? "journey-student");
    const approval = await browser.approveDevice(verificationUri, options.deviceName, userCode);
    case_.expect(
      approval.shownCode === userCode && approval.statusLine.includes("Device approved"),
      `the browser approved device ${options.deviceName} with the page's own button, once`,
      `page showed ${approval.shownCode ?? "no code"} for ${userCode}; status line: ${approval.statusLine.slice(0, 160)}`,
    );
  } finally {
    await browser.close();
  }
  const exit = await link.exited(60_000);
  case_.command("cogworks link --portal <shaper> --no-browser", exit, link.output());
  case_.expect(exit === 0 && /Linked\b/.test(link.output()), "the CLI linked", `exit ${exit}; output: ${link.output().slice(-400)}`);
}
