/**
 * Every device approval in the journeys goes through a real browser, once.
 *
 * Before this fix (c722ed79) benchmark-real-run.ts:101-106 and
 * adversarial.ts:49-53 approved by POSTing /api/v1/cli/device/approve from
 * Node and retried once on a 5xx, so a flaky approval could pass and the
 * student's actual approval page was never pressed in those journeys.
 *
 * This test reads the journey and support sources and fails if anything
 * outside the browser helper calls the approve endpoint, defines an HTTP
 * approval helper, or links a CLI without the browser path.
 *
 * Run: npx tsx tests/approval-path.ts  (no network, no stack)
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SUITE = fileURLToPath(new URL("..", import.meta.url));
let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  console.log(`[${ok ? "ok" : "FAIL"}] ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
}

const sources: Array<[string, string]> = [];
for (const dir of ["journeys", "support"]) {
  for (const name of await readdir(join(SUITE, dir))) {
    if (/\.(ts|mjs)$/.test(name)) sources.push([`${dir}/${name}`, await readFile(join(SUITE, dir, name), "utf8")]);
  }
}

const approveEndpoint = sources.filter(([, text]) => text.includes("/api/v1/cli/device/approve"));
check("no journey or helper calls the approve endpoint over HTTP", approveEndpoint.length === 0, approveEndpoint.map(([file]) => file).join(", "));

const httpApprovals = sources.filter(([file, text]) => file !== "support/browser.ts" && /\.approveDevice\(/.test(text) && !/BrowserSession|browser\.approveDevice|browserSession\.approveDevice/.test(text));
check("approveDevice is only called on a browser session", httpApprovals.length === 0, httpApprovals.map(([file]) => file).join(", "));

// Every `cogworks link` a journey starts is approved in the browser: the file
// that starts one must also use linkThroughBrowser or a BrowserSession.
const linkers = sources.filter(([, text]) => /start\(\[\s*"link"/.test(text));
for (const [file, text] of linkers) {
  check(`${file} approves its links in a browser`, /BrowserSession|linkThroughBrowser/.test(text));
}
check("the link helper and setup journey are among the files checked", linkers.some(([file]) => file === "support/link.ts") && linkers.some(([file]) => file === "journeys/setup-and-link.ts"));

if (failures > 0) {
  console.error(`approval-path: ${failures} check(s) failed`);
  process.exit(1);
}
console.log("approval-path: all checks passed");
