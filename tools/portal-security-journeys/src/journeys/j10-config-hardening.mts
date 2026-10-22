import { execSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { bootStack } from "../lib/stack.mts";
import { refused, type Check, type Journey } from "../lib/framework.mts";

type JsoncValue = { [key: string]: JsoncValue | unknown } | unknown[] | string | number | boolean | null;

/** Minimal JSONC reader: the committed wrangler.jsonc carries comments and trailing commas. */
function parseJsonc(text: string): JsoncValue {
  const stripped = text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|\s)\/\/[^\n]*/g, "$1")
    .replace(/,(\s*[}\]])/g, "$1");
  return JSON.parse(stripped) as JsoncValue;
}

function devAuthValue(vars: unknown): string | undefined {
  const v = vars as { DEV_AUTH?: unknown } | undefined;
  return typeof v?.DEV_AUTH === "string" ? v.DEV_AUTH.replace(/^"|"$/g, "") : undefined;
}

/**
 * J10 — dev-only auth surfaces stay off in hardened configs. Source gate
 * (apps/portal/src/lib/auth.ts / worker routes): dev login answers only when
 * ENVIRONMENT=development AND DEV_AUTH=enabled AND GitHub OAuth is not
 * configured (both a client id and a client secret present). The committed
 * wrangler.jsonc must never enable it: every named environment carries DEV_AUTH=disabled while the top-level
 * vars leave it unset (the gate fails closed without DEV_AUTH; local
 * development enables it only through the untracked .dev.vars), and the only tracked file that
 * documents an enabled value is the gitignored-template .dev.vars.example.
 * The live arms boot two hardened variants: DEV_AUTH disabled, and DEV_AUTH
 * enabled but GitHub configured — /api/dev/login must refuse in both.
 */
export const j10: Journey = {
  id: "j10-config-hardening",
  title:
    "Committed wrangler environments keep DEV_AUTH disabled, the repo tracks no enabling .dev.vars, and hardened boots refuse the dev-login surface",
  fixedInput: "fresh stacks in two hardened configs + committed wrangler vars",
  needsStack: false,
  async run(_stack, log) {
    const checks: Check[] = [];

    // --- static arm: committed configuration (no server) ---
    const root = process.cwd().includes("tools/portal-security-journeys")
      ? process.cwd().replace(/tools\/portal-security-journeys.*/s, "")
      : process.cwd();
    const portalDir = join(root, "apps", "portal");
    const cfg = parseJsonc(readFileSync(join(portalDir, "wrangler.jsonc"), "utf8")) as {
      vars?: unknown;
      env?: Record<string, { vars?: unknown }>;
    };

    const topLevel = devAuthValue(cfg.vars);
    checks.push(
      topLevel !== "enabled"
        ? { name: "apps/portal/wrangler.jsonc top-level vars leave DEV_AUTH disabled-or-absent (fail closed)", ok: true, detail: `DEV_AUTH=${topLevel ?? "absent (gate fails closed)"}` }
        : { name: "apps/portal/wrangler.jsonc top-level vars leave DEV_AUTH disabled-or-absent (fail closed)", ok: false, detail: `observed DEV_AUTH=${String(topLevel)}` },
    );

    const envs = Object.entries(cfg.env ?? {});
    const enabledEnvs = envs.filter(([, e]) => devAuthValue(e?.vars) !== "disabled");
    checks.push(
      envs.length > 0 && enabledEnvs.length === 0
        ? { name: "every committed wrangler.jsonc environment sets DEV_AUTH=disabled", ok: true, detail: `environments: ${envs.map(([n]) => n).join(", ")}` }
        : { name: "every committed wrangler.jsonc environment sets DEV_AUTH=disabled", ok: false, detail: enabledEnvs.length ? `not disabled in: ${enabledEnvs.map(([n]) => n).join(", ")}` : "no env block found" },
    );

    let tracked: string[] = [];
    try {
      tracked = execSync("git ls-files apps/portal", { cwd: root, encoding: "utf8" })
        .split("\n")
        .filter((f) => f.endsWith("dev.vars") || f.endsWith(".dev.vars.example") || f.includes("dev.vars"));
    } catch (err) {
      log(`git ls-files failed: ${String(err).slice(0, 120)}`);
    }
    // The name of this check is the assertion: ANY tracked dev-vars file other
    // than the example — .dev.vars, .dev.vars.local, .dev.vars.<anything> —
    // is an enabling file shipped to the repository, whatever its suffix.
    const unapproved = tracked.filter((f) => !f.endsWith(".dev.vars.example"));
    checks.push(
      tracked.includes("apps/portal/.dev.vars.example") && unapproved.length === 0
        ? { name: ".dev.vars.example is the only tracked dev-vars file and no .dev.vars is committed", ok: true, detail: tracked.join(", ") || "(none)" }
        : { name: ".dev.vars.example is the only tracked dev-vars file and no .dev.vars is committed", ok: false, detail: `tracked: ${tracked.join(", ") || "none"}; unapproved: ${unapproved.join(", ") || "none"}` },
    );

    const example = readFileSync(join(portalDir, ".dev.vars.example"), "utf8");
    const exampleDevAuth = /^DEV_AUTH=(.*)$/m.exec(example)?.[1]?.trim().replace(/^"|"$/g, "");
    checks.push(
      exampleDevAuth === "enabled"
        ? { name: ".dev.vars.example documents DEV_AUTH=enabled for local development only", ok: true, detail: "DEV_AUTH=enabled in the example template" }
        : { name: ".dev.vars.example documents DEV_AUTH=enabled for local development only", ok: false, detail: `observed DEV_AUTH=${String(exampleDevAuth)}` },
    );


    // --- dist secret-scan (own file only): after a production build, the
    // bundles must carry no committed-looking secret values. Needles target
    // values, not env-var names — the worker bundle legitimately contains
    // env.BETTER_AUTH_SECRET-style lookups. Skips with a logged reason when
    // dist is absent (no production build available).
    const distDir = join(portalDir, "dist");
    if (existsSync(distDir)) {
      const needles: Array<[RegExp, string]> = [
        [/sec-journeys/i, "harness placeholder secret literal"],
        [/cogportal-local-dev-secret/i, "local development secret literal"],
        [/gh[pousr]_[A-Za-z0-9]{20,}/, "GitHub token-shaped credential"],
      ];
      let scanned = 0;
      const hits: string[] = [];
      const walk = (dir: string): void => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          const p = join(dir, entry.name);
          if (entry.isDirectory()) walk(p);
          else if (entry.isFile()) {
            scanned += 1;
            const text = readFileSync(p, "utf8");
            for (const [re, label] of needles) {
              if (re.test(text)) hits.push(`${p.replace(distDir + "/", "")}: ${label}`);
            }
          }
        }
      };
      walk(distDir);
      checks.push(
        hits.length === 0
          ? { name: "apps/portal/dist production bundles carry no committed-looking secrets", ok: true, detail: `${scanned} files scanned under dist` }
          : { name: "apps/portal/dist production bundles carry no committed-looking secrets", ok: false, detail: hits.slice(0, 6).join("; ") },
      );
    } else {
      log("apps/portal/dist missing — dist secret-scan skipped (no production build present)");
    }

    // --- live variant 1: DEV_AUTH disabled (1 of max 2 boots) ---
    const variant1 = await bootStack("j10-variant1", log, { devAuth: false });
    try {
      const post = await fetch(`${variant1.baseUrl}/api/dev/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ login: "j10probe", demo: true, password: "cogportal-local-dev-password" }),
      });
      checks.push(refused("POST /api/dev/login refuses 4xx when DEV_AUTH=disabled", post.status, await post.text()));
      const get = await fetch(`${variant1.baseUrl}/api/dev/login`);
      checks.push(refused("GET /api/dev/login refuses when DEV_AUTH=disabled", get.status, await get.text()));
    } finally {
      await variant1.teardown();
    }

    // --- live variant 2: DEV_AUTH enabled but GitHub OAuth configured (2 of 2) ---
    const variant2 = await bootStack("j10-variant2", log, { withGithubConfig: true });
    try {
      const post = await fetch(`${variant2.baseUrl}/api/dev/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ login: "j10probe", demo: true, password: "cogportal-local-dev-password" }),
      });
      checks.push(refused("POST /api/dev/login refuses when GitHub OAuth is configured (dev-auth gate requires an unconfigured GitHub)", post.status, await post.text()));
    } finally {
      await variant2.teardown();
    }

    return checks;
  },
}
