/**
 * Runs axe-core against three key screens of the built portal served by the
 * fixture server: the connect choice screen, the setup rail, and the
 * connections device list. Same no-real-GitHub discipline as walk.mjs.
 */
import { chromium } from "playwright";
import { writeFileSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const axeSource = readFileSync(new URL("./node_modules/axe-core/axe.js", import.meta.url), "utf8");

const BASE = "http://localhost:4173";

async function setScenario(page, scenario, extra = {}) {
  const resp = await page.request.post(`${BASE}/__fixture`, { data: { scenario, ...extra } });
  if (!resp.ok()) throw new Error(`fixture set failed: ${resp.status()}`);
}

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();

const results = [];

async function scan(label, url, scenario) {
  await setScenario(page, scenario);
  await page.goto(`${BASE}${url}`, { waitUntil: "networkidle" });
  await page.waitForTimeout(400);
  await page.addScriptTag({ content: axeSource });
  const axe = await page.evaluate(() => window.axe.run(document, { resultTypes: ["violations", "incomplete"] }));
  results.push({
    label, url,
    violations: axe.violations.map((v) => ({ id: v.id, impact: v.impact, nodes: v.nodes.length, sample: v.nodes.slice(0, 2).map((n) => n.target.join(" ")) })),
    incomplete: axe.incomplete.map((v) => ({ id: v.id, nodes: v.nodes.length })),
    passes: axe.passes.length,
  });
}

await scan("connect choice screen", "/connect", "first-run");
await scan("setup rail (created, 1 of 5)", "/setup", "first-run");
await scan("connections device list", "/connections?user_code=ABCD-1234-EFGH&return_to=setup", "first-run");

writeFileSync(fileURLToPath(new URL("./axe-report.json", import.meta.url)), JSON.stringify(results, null, 2));
for (const r of results) {
  console.log(`\n== ${r.label} (${r.url}) — ${r.passes} rule passes`);
  for (const v of r.violations) console.log(`  VIOLATION ${v.impact ?? "?"} ${v.id} × ${v.nodes}: ${v.sample.join(" | ")}`);
  for (const v of r.incomplete) console.log(`  incomplete ${v.id} × ${v.nodes}`);
}
await browser.close();
