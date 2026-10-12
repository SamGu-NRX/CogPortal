import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { REPO_ROOT, env } from "./cli.ts";
import { requireLoopbackOrigin } from "./loopback.ts";

/**
 * What the stack harness wrote at boot. The journeys learn every origin from
 * this file, never from a constant, so the stack is the only thing that
 * decides where its pieces listen.
 */
export interface StackInfo {
  ready: true;
  /** The shaper in front of the portal Worker: what a browser would visit. */
  browsableOrigin: string;
  /** The portal Worker's canonical origin (a portal.journey.test hostname). */
  portalOrigin: string;
  /** The CogBot Worker's canonical origin (a bot.journey.test hostname). */
  botOrigin: string;
  /** The shaper front for the portal: HTTP-reachable (127.0.0.1). */
  shaperPortalOrigin: string;
  /** The shaper front for the bot: HTTP-reachable (127.0.0.1). */
  shaperBotOrigin: string;
  /** The shaper's control plane (fault injection lives here). */
  shaperControlOrigin: string;
  /** The loopback Discord REST double. */
  discordDoubleOrigin: string;
  /** The bot's Ed25519 public key (hex), which journeys sign with. */
  discordPublicKeyHex: string;
  /** The bot's Ed25519 private key (PKCS8 PEM), for signing interactions the way Discord does. */
  discordPrivateKeyPem: string;
  /** The guild id the local bot and portal both expect. */
  courseGuildId: string;
  /** Where the Discord double records its requests (JSON, GET). */
  discordDoubleLogPath: string;
  /** Absolute path of the file the harness logs every receipt-side fact to. */
  stackLog: string;
}

export async function readStackInfo(): Promise<StackInfo> {
  const path = env("STACK_INFO");
  const info = JSON.parse(await readFile(path, "utf8")) as StackInfo;
  // Every origin a journey or CLI can actually dial must be loopback-only --
  // the stack harness binds nothing else, so a foreign host here means a
  // hostile or stale STACK_INFO, and the run refuses loudly.
  const dialed = [
    ["browsableOrigin", info.browsableOrigin],
    ["shaperPortalOrigin", info.shaperPortalOrigin],
    ["shaperBotOrigin", info.shaperBotOrigin],
    ["shaperControlOrigin", info.shaperControlOrigin],
    ["discordDoubleOrigin", info.discordDoubleOrigin],
  ] as const;
  for (const [name, origin] of dialed) {
    requireLoopbackOrigin(origin, `the booted stack's ${name} (STACK_INFO)`);
  }
  return info;
}

/** Which documented staging pin a run exercised, when the pin matrix set one. */
export interface PinLabel {
  /** The staging environment's pin id: which copy of benchmark-packages.ts. */
  id: string;
  /** The revision whose copy of benchmark-packages.ts the pin was read from. */
  revision: string;
  /** The CLI source the pin's COGBENCH_SOURCE resolves to (a pip git+ reference). */
  source: string;
}

/** One receipt per case. Written next to the run's other results, not committed. */
export interface Receipt {
  journey: string;
  case: string;
  status: "PASS" | "FAIL" | "BLOCKED" | "NOT_RUN";
  /** Every surface-level claim the case asserted, with the evidence for it. */
  claims: Array<{ claim: string; evidence: string }>;
  /** Pieces of the stack this case touched, named as in the README's table. */
  touched: string[];
  /** The exact commands the case ran, with outcomes and raw output. */
  commands?: Array<{ args: string; exit: number | null; output: string }>;
  /** What stopped the case, when the status is not PASS. */
  blockedReason?: string;
  /** The staging pin the CLI came from, when the case ran under the pin matrix. */
  pin?: PinLabel;
  /**
   * Whether the run bar treats this case as required: a required case that
   * FAILs or is BLOCKED fails the run's verdict (report.mjs). Absent means
   * required - fail-closed - so only a deliberate `required: false` witness
   * is exempt.
   */
  required?: boolean;
}

export async function writeReceipt(receipt: Receipt): Promise<void> {
  const resultsDir = env("RESULTS_DIR");
  const file = join(
    resultsDir,
    "receipts",
    `${receipt.journey}--${receipt.case.replace(/[^a-z0-9-]+/gi, "-")}.json`,
  );
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(receipt, null, 2));
}

/** Absolute path of this checkout's built portal dist directory. */
export function portalDist(): string {
  return join(REPO_ROOT, "apps", "portal", "dist");
}
