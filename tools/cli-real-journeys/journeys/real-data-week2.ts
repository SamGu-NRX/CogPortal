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
  allowedUndocumentedHosts,
  cliTraffic,
  parseReport,
  placeEgressMarker,
  refusedEvents,
  runCogworks,
  trafficSummary,
  undocumentedHosts,
  zeroRequestViolation,
} from "./real-data-common.ts";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

/**
 * The week 2 public-data journey, run against one staging pin of the CLI in
 * one course environment (run-all.sh installs the pin and exports its
 * identity; the receipts carry it). The contract under test:
 *
 *   - `cogworks check` with cold caches reports them missing and touches
 *     nothing — zero witnessed network events from an offline command (any
 *     event, allowed or refused, fails the claim).
 *   - the FIRST real-data run downloads the documented public assets (the
 *     CelebA test data through Hugging Face, the FaceNet checkpoint from its
 *     GitHub release) through the witness, which records every host and byte
 *     in the receipt; nothing is pre-seeded (the journey home starts empty).
 *   - a real scored recognition case and a real scored clustering case run
 *     end-to-end on the real data, with the fixture submission binding the
 *     benchmark's packaged entry-point protocol.
 *   - afterwards, with warm caches, `check` reports ready — again with zero
 *     witnessed events, proving the offline path never phones the Portal or
 *     any provider.
 *
 * The planted-probe case proves the detectors themselves work: with the
 * witness offline, a deliberate request to a non-documented host is refused
 * pre-connect and the refusal is visible in the log the journeys assert
 * against; and a deliberate request to a DOCUMENTED public-asset host — the
 * mutation the old undocumented-host check was blind to — fails the
 * zero-request claim.
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

  // Planted probe 2 (the mutation): a request to a DOCUMENTED public-asset
  // host during a window a silent command would claim is zero-traffic. The
  // request succeeds (the host is documented), the old undocumented-host
  // check passes the window — that blindness was the defect — and the
  // zero-request claim's detector must fail it.
  const mutationMarker = await placeEgressMarker("planted-documented-host");
  let mutationExit = 0;
  try {
    await run("curl", ["-sS", "-o", "/dev/null", "--max-time", "20", "https://github.com/"], {
      env: { ...process.env, https_proxy: proxy },
      timeout: 30_000,
    });
  } catch (error) {
    mutationExit = (error as { code?: number }).code ?? -1;
  }
  const mutationEvents = await cliTraffic(mutationMarker);
  const oldCheckBlind = undocumentedHosts(mutationEvents).length === 0;
  const mutationVerdict = zeroRequestViolation(mutationEvents);
  case_.expect(
    mutationVerdict !== null,
    "a planted request to a DOCUMENTED host fails the zero-request claim — the old undocumented-host check alone passed this window, which was the defect",
    `curl exit ${mutationExit}; old check (undocumentedHosts): ${oldCheckBlind ? "PASSED (blind)" : "failed"}; zero-request detector: ${mutationVerdict}`,
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
    const violation = zeroRequestViolation(events);
    case_.expect(
      violation === null,
      "the offline check made zero network requests — any witnessed event, allowed or refused, fails the claim",
      violation ?? "the witness saw no events at all",
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
    const allowedOffenders = allowedUndocumentedHosts(events);
    const refusedEvents_ = refusedEvents(events);
    case_.expect(
      allowedOffenders.length === 0,
      "every host the first run successfully contacted is a documented public-asset host",
      `${trafficSummary(events)}${allowedOffenders.length ? ` — ALLOWED BUT UNDOCUMENTED: ${allowedOffenders.join(", ")}` : ""}`,
    );
    case_.claim(
      "refused egress (fail-closed proxy: refused pre-connect, nothing forwarded)",
      refusedEvents_.length > 0 ? `${trafficSummary(refusedEvents_)} — root cause: the datasets download-count beacon and any other non-documented attempt` : "none",
    );
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
    const allowedOffenders = allowedUndocumentedHosts(events);
    const refusedEvents_ = refusedEvents(events);
    case_.expect(
      allowedOffenders.length === 0,
      "every host the clustering run successfully contacted is a documented public-asset host",
      `${trafficSummary(events)}${allowedOffenders.length ? ` — ALLOWED BUT UNDOCUMENTED: ${allowedOffenders.join(", ")}` : ""}`,
    );
    case_.claim(
      "refused egress (fail-closed proxy: refused pre-connect, nothing forwarded)",
      refusedEvents_.length > 0 ? `${trafficSummary(refusedEvents_)} — root cause: the datasets download-count beacon and any other non-documented attempt` : "none",
    );
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
    const violation = zeroRequestViolation(events);
    case_.expect(
      violation === null,
      "the offline check on warm caches made zero network requests — any witnessed event, allowed or refused, fails the claim",
      violation ?? "the witness saw no events at all",
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
