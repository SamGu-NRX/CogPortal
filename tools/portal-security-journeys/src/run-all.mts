/**
 * Suite entrypoint: discovers journeys in src/journeys, runs them in id
 * order, writes results/report.md + results/report.json, exits non-zero on
 * any failure. Usage: pnpm journeys [id-filter]
 */
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { SkipJourney, skipJourneyResult, summarize, type Journey, type JourneyResult, type Stack } from "./lib/framework.mts";

// Journeys boot their own stack via withStack; this stub only satisfies the
// signature for future runner-injected stacks.
const stub: Stack = { baseUrl: "", port: 0, root: process.cwd(), log: () => {}, teardown: async () => {}, d1: () => "" };

async function loadJourneys(): Promise<Journey[]> {
  const dir = fileURLToPath(new URL("./journeys", import.meta.url));
  const journeys: Journey[] = [];
  for (const f of readdirSync(dir).filter((f) => /^j\d+.*\.mts$/.test(f)).sort()) {
    const mod = await import(new URL(`./journeys/${f}`, import.meta.url).href);
    for (const v of Object.values(mod)) {
      if (v && typeof v === "object" && "id" in (v as object) && "run" in (v as object)) journeys.push(v as Journey);
    }
  }
  return journeys;
}

export async function main(filter?: string): Promise<JourneyResult[]> {
  const results: JourneyResult[] = [];
  for (const j of await loadJourneys()) {
    if (filter && !j.id.includes(filter)) continue;
    const t0 = Date.now();
    const log = (line: string) => console.log(`  [${j.id}] ${line}`);
    try {
      const checks = await j.run(stub, log);
      results.push({
        id: j.id,
        title: j.title,
        fixedInput: j.fixedInput,
        status: checks.length > 0 && checks.every((c) => c.ok) ? "pass" : "fail",
        checks,
        ms: Date.now() - t0,
      });
    } catch (err) {
      results.push(
        err instanceof SkipJourney
          ? // Preserve the checks collected before the skip; a failed check
            // keeps the journey (and the process) failed.
            skipJourneyResult(j, err, Date.now() - t0)
          : {
              id: j.id,
              title: j.title,
              fixedInput: j.fixedInput,
              status: "fail",
              checks: [{ name: "journey crashed", ok: false, detail: String((err as Error).stack ?? err).slice(0, 800) }],
              ms: Date.now() - t0,
            },
      );
    }
  }
  return results;
}

const filter = process.argv[2];
const results = await main(filter);
const outDir = fileURLToPath(new URL("./results", import.meta.url));
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, "report.json"), JSON.stringify({ generatedAt: new Date().toISOString(), results }, null, 2));
writeFileSync(join(outDir, "report.md"), summarize(results) + "\n");
console.log(summarize(results));
if (!results.length) {
  console.error("no journeys matched");
  process.exit(2);
}
if (results.some((r) => r.status === "fail")) process.exit(1);
