import { chromium } from "playwright";
import { readFileSync } from "node:fs";
const axeSource = readFileSync("./node_modules/axe-core/axe.js", "utf8");
const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
await page.goto("http://127.0.0.1:3100/plans", { waitUntil: "networkidle" });
await page.addScriptTag({ content: axeSource });
const summary = await page.evaluate(() => {
  return window.axe.run(document, { resultTypes: ["violations"] }).then((axe) => {
    const out = [];
    for (const v of axe.violations.filter((v) => v.id === "color-contrast")) {
      for (const node of v.nodes.slice(0, 8)) {
        const d = node.any[0]?.data ?? {};
        out.push({
          target: node.target.join(" "),
          html: node.html.slice(0, 140),
          fgColor: d.fgColor,
          bgColor: d.bgColor,
          contrastRatio: d.contrastRatio,
          expectedContrastRatio: d.expectedContrastRatio,
          fontSize: d.fontSize,
          fontWeight: d.fontWeight,
        });
      }
    }
    return out;
  });
});
console.log(JSON.stringify(summary, null, 1));
await browser.close();
