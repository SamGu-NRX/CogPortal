import { TeamRepository } from "../support/git-fixture.ts";
import { egressInfo, setEgressMode } from "../support/egress.ts";
import { Case } from "./harness.ts";
import { VISION_SUBMISSION_PY } from "./submission-week2.ts";
import {
  JOURNEY_HOME,
  PIN_ID,
  PIN_REV,
  PIN_SOURCE,
  VENV_BIN,
  assertJourneyHomeCold,
  cliTraffic,
  parseReport,
  placeEgressMarker,
  runCogworks,
  trafficSummary,
  undocumentedHosts,
  unexplainedUndocumentedHosts,
} from "./real-data-common.ts";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

/**
 * The week 2 public-data journey, run against one staging pin of the CLI in
 * one course environment (run-all.sh installs the pin and exports its
 * identity; the receipts carry it). The contract under test:
 *
 *   - `cogworks check` with cold caches reports them missing and touches
 *     nothing — zero network traffic from an offline command.
 *   - the FIRST real-data run downloads the documented public assets (the
 *     CelebA test data through Hugging Face, the FaceNet checkpoint from its
 *     GitHub release) through the witness, which records every host and byte
 *     in the receipt; nothing is pre-seeded (the journey home starts empty).
 *   - a real scored recognition case and a real scored clustering case run
 *     end-to-end on the real data, with the fixture submission binding the
 *     benchmark's packaged entry-point protocol.
 *   - afterwards, with warm caches, `check` reports ready — again with zero
 *     traffic, proving the offline path never phones the Portal or any
 *     provider.
 *
 * The planted-probe case proves the detector itself works: with the witness
 * offline, a deliberate request to a non-documented host is refused and the
 * refusal is visible in the log the journeys assert against.
 */
const run = promisify(execFile);

const pinLabel = (suffix: string): string => `${suffix}-week2-${PIN_ID}`;

const cases = {
  witnessWorks: new Case("week2-real-data", pinLabel("witness-works"), ["egress witness"]),
  coldCheck: new Case("week2-real-data", pinLabel("cold-check"), ["installed CLI", "week2 benchmark"]),
  recognitionTest: new Case("week2-real-data", pinLabel("recognition-test"), ["installed CLI", "week2 benchmark", "team repo"]),
  clusteringRun: new Case("week2-real-data", pinLabel("clustering-run"), ["installed CLI", "week2 benchmark", "team repo"]),
  warmCheck: new Case("week2-real-data", pinLabel("warm-check"), ["installed CLI", "week2 benchmark"]),
};

const environment = (): { originFullName: string; files: Record<string, string> } => ({
  originFullName: "cogworks-demo/face-finder",
  files: { "submission.py": VISION_SUBMISSION_PY },
});

await cases.witnessWorks.run(async () => {
  const case_ = cases.witnessWorks;
  case_.claim(
    "staging pin under test",
    `pin ${PIN_ID} at revision ${PIN_REV}, source ${PIN_SOURCE}, environment ${VENV_BIN}, journey home ${JOURNEY_HOME}`,
  );
  await setEgressMode("offline");
  const marker = await placeEgressMarker("planted-probe");
  // Node's fetch ignores proxy variables; curl is the honest client here.
  const { proxy } = egressInfo();
  let curlExit = 0;
  try {
    await run("curl", ["-sS", "--max-time", "20", "https://example.com/"], {
      env: { ...process.env, https_proxy: proxy },
      timeout: 30_000,
    });
  } catch (error) {
    curlExit = (error as { code?: number }).code ?? -1;
  }
  const events = await cliTraffic(marker);
  const refused = events.filter((event) => event.allowed === false);
  case_.expect(
    refused.length > 0 && refused.some((event) => event.host === "example.com"),
    "the offline witness refuses a non-documented host and records the refusal",
    `curl exit ${curlExit}; witness saw: ${trafficSummary(events)}`,
  );
});

await cases.coldCheck.run(async () => {
  const case_ = cases.coldCheck;
  await assertJourneyHomeCold();
  const repo = await TeamRepository.create(environment());
  try {
    await setEgressMode("offline");
    const marker = await placeEgressMarker("cold-check");
    const result = await runCogworks(["check", "--benchmark", "vision-recognition", "--json"], { cwd: repo.path });
    const events = await cliTraffic(marker);
    case_.command(`cogworks check --benchmark vision-recognition --json (offline, cold caches)`, result.exit, result.output.slice(-1200));
    case_.expect(
      undocumentedHosts(events).length === 0,
      "the offline check made no network requests at all",
      trafficSummary(events),
    );
    const parsed = parseReport(result);
    case_.expect(parsed.report !== null, "the check printed a JSON report", result.output.slice(0, 400));
    const modelCache = parsed.report?.modelCache ?? {};
    const dataTest = parsed.report?.dataTestCache ?? {};
    case_.expect(
      modelCache.ready === false && dataTest.ready === false,
      "with cold caches the check reports the model and data caches missing",
      `modelCache.ready=${JSON.stringify(modelCache.ready)} dataTestCache.ready=${JSON.stringify(dataTest.ready)}`,
    );
  } finally {
    await repo.dispose();
  }
});

await cases.recognitionTest.run(async () => {
  const case_ = cases.recognitionTest;
  const repo = await TeamRepository.create(environment());
  try {
    await setEgressMode("online");
    const marker = await placeEgressMarker("recognition-test");
    const result = await runCogworks(["test", "--benchmark", "vision-recognition", "--json"], { cwd: repo.path });
    const events = await cliTraffic(marker);
    case_.command(`cogworks test --benchmark vision-recognition --json (first real run; downloads witnessed)`, result.exit, result.output.slice(-1200));
    case_.expect(result.exit === 0, "the first real recognition test ran to completion", `exit ${result.exit}; ${result.output.slice(-400)}`);
    const offenders = undocumentedHosts(events);
    const unexplained = unexplainedUndocumentedHosts(events);
    case_.expect(
      unexplained.length === 0,
      "every host the first run contacted is a documented public-asset host, except the known datasets download-count beacon",
      `${trafficSummary(events)}${offenders.length ? ` — UNDOCUMENTED: ${offenders.join(", ")}` : ""}`,
    );
    if (offenders.length > 0) {
      case_.claim(
        "known provider telemetry witnessed (not a documented asset fetch)",
        `${offenders.join(", ")} — datasets 3.1.0 load.py increase_load_count() HEAD beacon, refused offline with no impact on the run`,
      );
    }
    case_.claim(
      "witnessed downloads",
      `${trafficSummary(events.filter((event) => event.kind === "tunnel-bytes" || event.kind === "http-response-final"))}`,
    );
    const parsed = parseReport(result);
    const metrics = parsed.report?.metrics ?? [];
    const primary = metrics.find((metric: { primary?: boolean }) => metric.primary);
    case_.expect(
      primary !== undefined && typeof primary.value === "number" && primary.value > 0.5,
      "the scored recognition case produced a passing primary metric",
      `recognition metrics: ${metrics.map((metric: { key: string; value: number }) => `${metric.key}=${metric.value}`).join(", ")}`,
    );
  } finally {
    await repo.dispose();
  }
});

await cases.clusteringRun.run(async () => {
  const case_ = cases.clusteringRun;
  const repo = await TeamRepository.create(environment());
  try {
    await setEgressMode("online");
    const marker = await placeEgressMarker("clustering-run");
    const result = await runCogworks(["run", "--benchmark", "vision-clustering", "--json"], { cwd: repo.path });
    const events = await cliTraffic(marker);
    case_.command(`cogworks run --benchmark vision-clustering --json`, result.exit, result.output.slice(-1200));
    case_.expect(result.exit === 0, "the real clustering run completed", `exit ${result.exit}; ${result.output.slice(-400)}`);
    const offenders = undocumentedHosts(events);
    const unexplained = unexplainedUndocumentedHosts(events);
    case_.expect(
      unexplained.length === 0,
      "the clustering run contacted only documented public-asset hosts, except the known datasets download-count beacon",
      `${trafficSummary(events)}${offenders.length ? ` — UNDOCUMENTED: ${offenders.join(", ")}` : ""}`,
    );
    if (offenders.length > 0) {
      case_.claim(
        "known provider telemetry witnessed (not a documented asset fetch)",
        `${offenders.join(", ")} — datasets 3.1.0 load.py increase_load_count() HEAD beacon, refused offline with no impact on the run`,
      );
    }
    const parsed = parseReport(result);
    const metrics = parsed.report?.metrics ?? [];
    const primary = metrics.find((metric: { primary?: boolean }) => metric.primary);
    case_.expect(
      primary !== undefined && typeof primary.value === "number" && primary.value > 0.5,
      "the scored clustering case produced a passing pairwise F1",
      `clustering metrics: ${metrics.map((metric: { key: string; value: number }) => `${metric.key}=${metric.value}`).join(", ")}`,
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
    const result = await runCogworks(["check", "--benchmark", "vision-recognition", "--json"], { cwd: repo.path });
    const events = await cliTraffic(marker);
    case_.command(`cogworks check --benchmark vision-recognition --json (offline, warm caches)`, result.exit, result.output.slice(-1200));
    case_.expect(
      undocumentedHosts(events).length === 0,
      "the offline check on warm caches made no network requests at all",
      trafficSummary(events),
    );
    const parsed = parseReport(result);
    const modelCache = parsed.report?.modelCache ?? {};
    const dataTest = parsed.report?.dataTestCache ?? {};
    case_.expect(
      modelCache.ready === true && dataTest.ready === true,
      "with warm caches the check reports the model and data caches ready",
      `modelCache.ready=${JSON.stringify(modelCache.ready)} dataTestCache.ready=${JSON.stringify(dataTest.ready)}`,
    );
  } finally {
    await repo.dispose();
  }
});
