import { chromium } from "playwright";
import { readFileSync } from "node:fs";
const axeSource = readFileSync("./node_modules/axe-core/axe.js", "utf8");
const browser = await chromium.launch();
for (const path of ["/courses", "/schedule"]) {
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  await page.goto(`http://127.0.0.1:3100${path}`, { waitUntil: "networkidle" });
  await page.addScriptTag({ content: axeSource });
  const axe = await page.evaluate(() => window.axe.run(document, { resultTypes: ["violations"] }));
  const cc = axe.violations.find(v => v.id === "color-contrast");
  console.log(`${path}: ${axe.violations.length} violation kinds; color-contrast nodes: ${cc ? cc.nodes.length : 0}`,
    cc ? cc.nodes.slice(0,3).map(n => n.target.join(" ")) : "");
  await page.context().close();
}
await browser.close();
