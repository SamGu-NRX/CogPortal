/* Minimal repro: why does one Approve click produce three 410 response events? */
import { chromium } from "playwright";

const BASE = "http://localhost:4173";
const browser = await chromium.launch();
const page = await browser.newPage();

await page.request.post(`${BASE}/__fixture`, { data: { scenario: "expired-code" } });

let n = 0;
page.on("request", (r) => {
  if (r.url().includes("approve")) console.log(`REQ  #${++n} ${r.method()} ${r.url()} postData=${JSON.stringify(r.postData())}`);
});
page.on("response", (r) => {
  if (r.url().includes("approve")) console.log(`RESP    ${r.status()} ${r.url()}`);
});
page.on("requestfinished", (r) => {
  if (r.url().includes("approve")) console.log(`DONE    ${r.url()}`);
});
page.on("requestfailed", (r) => {
  if (r.url().includes("approve")) console.log(`FAIL    ${r.url()} ${r.failure()?.errorText}`);
});

await page.goto(`${BASE}/connections?user_code=ABCD-1234-EFGH`, { waitUntil: "networkidle" });
await page.waitForTimeout(500);

const name = page.getByLabel(/device/i);
if (await name.count()) await name.fill("Sam's laptop");
await page.getByRole("button", { name: "Approve device" }).click();
await page.waitForTimeout(2000);

await browser.close();
