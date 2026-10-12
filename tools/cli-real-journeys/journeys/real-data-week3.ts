import { TeamRepository } from "../support/git-fixture.ts";
import { setEgressMode } from "../support/egress.ts";
import { Case } from "./harness.ts";
import { LANGUAGE_SUBMISSION_PY } from "./submission-week3.ts";
import {
  JOURNEY_HOME,
  PIN_ID,
  PIN_REV,
  PIN_SOURCE,
  VENV_BIN,
  assertJourneyHomeCold,
  assertOnlineEgress,
  cliTraffic,
  parseReport,
  placeEgressMarker,
  runCogworks,
  zeroRequestViolation,
} from "./real-data-common.ts";

/**
 * The week 3 public-data journey, run against one staging pin of the CLI in
 * one course environment (run-all.sh installs the pin and exports its
 * identity; the receipts carry it). Same contract as week 2:
 *
 *   - `cogworks check` with cold caches reports every cache missing and
 *     touches nothing — zero witnessed network events (any event, allowed or
 *     refused, fails the claim).
 *   - the first real-data run downloads the benchmark's documented public
 *     assets — the caption/descriptor release artifacts and the GloVe
 *     vectors, SHA-256-pinned, GitHub with a Dropbox fallback — through the
 *     witness, which records every host and byte. Nothing is pre-seeded.
 *   - a real scored test case and a real scored run execute on the real
 *     data with the text-branch submission fixture: GloVe-mean caption
 *     embeddings, one row per caption. The fixture deliberately implements
 *     no image branch; the benchmark reports the missing surfaces and
 *     scores the text metric, so the receipts show text scores and never
 *     fabricate an overall number.
 *   - with warm caches, `check` reports ready — again with zero traffic.
 */
const pinLabel = (suffix: string): string => `${suffix}-week3-${PIN_ID}`;

const cases = {
  coldCheck: new Case("week3-real-data", pinLabel("cold-check"), ["installed CLI", "week3 benchmark"]),
  languageTest: new Case("week3-real-data", pinLabel("language-test"), ["installed CLI", "week3 benchmark", "team repo"]),
  languageRun: new Case("week3-real-data", pinLabel("language-run"), ["installed CLI", "week3 benchmark", "team repo"]),
  warmCheck: new Case("week3-real-data", pinLabel("warm-check"), ["installed CLI", "week3 benchmark"]),
};

const environment = (): { originFullName: string; files: Record<string, string> } => ({
  originFullName: "cogworks-demo/scene-describer",
  files: { "submission.py": LANGUAGE_SUBMISSION_PY },
});

/** The week 3 check report's cache fields, however the benchmark names them. */
function cacheEntries(report: Record<string, any> | null): Array<[string, { ready?: boolean }]> {
  if (report === null) return [];
  return Object.entries(report).filter(
    ([key, value]) => /cache/i.test(key) && value !== null && typeof value === "object",
  ) as Array<[string, { ready?: boolean }]>;
}

await cases.coldCheck.run(async () => {
  const case_ = cases.coldCheck;
  case_.claim(
    "staging pin under test",
    `pin ${PIN_ID} at revision ${PIN_REV}, source ${PIN_SOURCE}, environment ${VENV_BIN}, journey home ${JOURNEY_HOME}`,
  );
  await assertJourneyHomeCold();
  const repo = await TeamRepository.create(environment());
  try {
    await setEgressMode("offline");
    const marker = await placeEgressMarker("cold-check");
    const result = await runCogworks(["check", "--benchmark", "language-search", "--json"], { cwd: repo.path });
    const events = await cliTraffic(marker);
    case_.command(`cogworks check --benchmark language-search --json (offline, cold caches)`, result.exit, result.output.slice(-1200));
    const violation = zeroRequestViolation(events);
    case_.expect(
      violation === null,
      "the offline check made zero network requests — any witnessed event, allowed or refused, fails the claim",
      violation ?? "the witness saw no events at all",
    );
    const parsed = parseReport(result);
    case_.expect(parsed.report !== null, "the check printed a JSON report", result.output.slice(0, 400));
    const caches = cacheEntries(parsed.report);
    case_.expect(caches.length > 0, "the check reports its cache state", `cache fields: ${caches.map(([key]) => key).join(", ")}`);
    const ready = caches.filter(([, value]) => value.ready === true);
    case_.expect(
      ready.length === 0,
      "with cold caches nothing reports ready",
      caches.map(([key, value]) => `${key}.ready=${JSON.stringify(value.ready)}`).join(", "),
    );
  } finally {
    await repo.dispose();
  }
});

await cases.languageTest.run(async () => {
  const case_ = cases.languageTest;
  const repo = await TeamRepository.create(environment());
  try {
    await setEgressMode("online");
    const marker = await placeEgressMarker("language-test");
    const result = await runCogworks(["test", "--benchmark", "language-search", "--json"], {
      cwd: repo.path,
      timeoutMs: 3_600_000,
    });
    const events = await cliTraffic(marker);
    case_.command(`cogworks test --benchmark language-search --json (first real run; downloads witnessed)`, result.exit, result.output.slice(-1200));
    case_.expect(result.exit === 0, "the first real language-search test ran to completion", `exit ${result.exit}; ${result.output.slice(-400)}`);
    assertOnlineEgress(case_, events, "the first language-search test");
    const parsed = parseReport(result);
    const metrics = parsed.report?.metrics ?? [];
    case_.expect(
      metrics.length > 0 && metrics.some((metric: { value?: number }) => typeof metric.value === "number"),
      "the scored test produced text-branch metrics",
      `language-search metrics: ${metrics.map((metric: { key: string; value: number }) => `${metric.key}=${metric.value}`).join(", ")}`,
    );
    case_.claim(
      "diagnostics (missing surfaces the benchmark reports honestly)",
      JSON.stringify(parsed.report?.diagnostics ?? []).slice(0, 600),
    );
  } finally {
    await repo.dispose();
  }
});

await cases.languageRun.run(async () => {
  const case_ = cases.languageRun;
  const repo = await TeamRepository.create(environment());
  try {
    await setEgressMode("online");
    const marker = await placeEgressMarker("language-run");
    const result = await runCogworks(["run", "--benchmark", "language-search", "--json"], {
      cwd: repo.path,
      timeoutMs: 3_600_000,
    });
    const events = await cliTraffic(marker);
    case_.command(`cogworks run --benchmark language-search --json`, result.exit, result.output.slice(-1200));
    case_.expect(result.exit === 0, "the real language-search run completed", `exit ${result.exit}; ${result.output.slice(-400)}`);
    assertOnlineEgress(case_, events, "the language-search run");
    const parsed = parseReport(result);
    const metrics = parsed.report?.metrics ?? [];
    case_.expect(
      metrics.length > 0 && metrics.some((metric: { value?: number }) => typeof metric.value === "number"),
      "the scored run produced text-branch metrics",
      `language-search metrics: ${metrics.map((metric: { key: string; value: number }) => `${metric.key}=${metric.value}`).join(", ")}`,
    );
    case_.claim(
      "diagnostics (missing surfaces the benchmark reports honestly)",
      JSON.stringify(parsed.report?.diagnostics ?? []).slice(0, 600),
    );
  } finally {
    await repo.dispose();
  }
});

await cases.warmCheck.run(async () => {
  const case_ = cases.warmCheck;
  const repo = await TeamRepository.create(environment());
  try {
    await setEgressMode("offline");
    const marker = await placeEgressMarker("warm-check");
    const result = await runCogworks(["check", "--benchmark", "language-search", "--json"], { cwd: repo.path });
    const events = await cliTraffic(marker);
    case_.command(`cogworks check --benchmark language-search --json (offline, warm caches)`, result.exit, result.output.slice(-1200));
    const violation = zeroRequestViolation(events);
    case_.expect(
      violation === null,
      "the offline check on warm caches made zero network requests — any witnessed event, allowed or refused, fails the claim",
      violation ?? "the witness saw no events at all",
    );
    const parsed = parseReport(result);
    const caches = cacheEntries(parsed.report);
    const ready = caches.filter(([, value]) => value.ready === true);
    case_.expect(
      ready.length > 0,
      "with warm caches the check reports the fetched data caches ready",
      caches.map(([key, value]) => `${key}.ready=${JSON.stringify(value.ready)}`).join(", "),
    );
  } finally {
    await repo.dispose();
  }
});
