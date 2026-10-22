import { chromium } from "playwright";
const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage();
await page.goto("http://127.0.0.1:3100/plans", { waitUntil: "networkidle" });
await page.waitForTimeout(600);
const wide = await page.evaluate(() => {
  const out = [];
  for (const el of document.querySelectorAll("*")) {
    const r = el.getBoundingClientRect();
    if (r.right > 391 || r.left < -1) {
      out.push({ tag: el.tagName, cls: String(el.className).slice(0, 40), right: Math.round(r.right), left: Math.round(r.left), w: Math.round(r.width), text: (el.textContent ?? "").slice(0, 50) });
    }
  }
  return out.slice(0, 12);
});
console.log(JSON.stringify(wide, null, 1));
await browser.close();
