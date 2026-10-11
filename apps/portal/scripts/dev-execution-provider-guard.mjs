// predev guard for `pnpm dev` (see the "predev" script in package.json).
//
// wrangler.jsonc's top-level vars are the CURRENT DEPLOYMENT's configuration —
// staging — and they set EXECUTION_PROVIDER="modal" with a staging
// MODAL_RUNNER_URL. A developer without a .dev.vars inherits them in a dev
// boot, and practice runs started from that portal would be dispatched to the
// real staging runner. This guard resolves EXECUTION_PROVIDER the same way the
// dev boot does (.dev.vars per key, else wrangler.jsonc top-level vars) and
// refuses to start on "modal" unless the developer's own .dev.vars opts in
// with ALLOW_MODAL_EXECUTION_IN_DEV. It runs only in the dev flow — never at
// deploy time — and the journeys harness boots the built portal through
// `vite preview`, so it never executes this file.
//
// COGPORTAL_DEV_GUARD_DEV_VARS / COGPORTAL_DEV_GUARD_WRANGLER_JSONC override
// the file paths; the tests use them to run the CLI hermetically.

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const EXECUTION_PROVIDER_VAR = "EXECUTION_PROVIDER";
export const ALLOW_MODAL_EXECUTION_IN_DEV = "ALLOW_MODAL_EXECUTION_IN_DEV";
const DEV_VARS_DISPLAY = "apps/portal/.dev.vars";

// Parse a .dev.vars file the way dotenv (vite/wrangler) does for the keys we
// care about: # comments, blank lines, optional "export " prefix, quoted
// values with the quotes stripped, unquoted values ending at whitespace + #.
// Returns raw string values; "" means present but empty.
export function parseDevVars(text) {
  const vars = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const body = line.replace(/^export\s+/i, "");
    const eq = body.indexOf("=");
    if (eq < 1) continue;
    const key = body.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = body.slice(eq + 1).trim();
    const quote = value[0] === '"' || value[0] === "'" ? value[0] : null;
    if (quote) {
      const end = value.indexOf(quote, 1);
      value = end > 0 ? value.slice(1, end) : value.slice(1);
    } else {
      const comment = value.search(/\s#/);
      if (comment >= 0) value = value.slice(0, comment).trim();
    }
    vars[key] = value;
  }
  return vars;
}

// Parse wrangler.jsonc: strip // and /* */ comments and trailing commas with
// one string-aware scan (URLs in values contain "//"), then JSON.parse.
// Throws on malformed JSON after stripping.
export function parseJsonc(text) {
  let out = "";
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
      continue;
    }
    if (ch === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i++;
      continue;
    }
    if (ch === ",") {
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j])) j++;
      if (text[j] === "}" || text[j] === "]") continue;
    }
    out += ch;
  }
  return JSON.parse(out);
}

// Resolve the EXECUTION_PROVIDER a dev boot would see: .dev.vars wins per key
// (an empty value is "shadowing with unset"), else wrangler.jsonc top-level.
export function resolveDevExecutionProvider({ devVars, devVarsPresent, configVars }) {
  const fromDevVars = devVarsPresent ? devVars[EXECUTION_PROVIDER_VAR] : undefined;
  const fromConfig = configVars && typeof configVars === "object" ? configVars[EXECUTION_PROVIDER_VAR] : undefined;
  const provider = fromDevVars === undefined || fromDevVars === "" ? fromConfig : fromDevVars;
  return provider === undefined ? undefined : String(provider);
}

function optInGranted(devVars, devVarsPresent) {
  if (!devVarsPresent) return false;
  const value = devVars[ALLOW_MODAL_EXECUTION_IN_DEV];
  return value !== undefined && /^(1|true)$/i.test(value.trim());
}

// Decide whether a dev boot may start. Fail-closed: only a resolved non-modal
// provider, or modal with an explicit .dev.vars opt-in, allows it.
export function evaluateDevProviderGuard({ devVars, devVarsPresent, configVars }) {
  const provider = resolveDevExecutionProvider({ devVars, devVarsPresent, configVars });
  if (provider !== "modal") return { allowed: true, provider };
  if (optInGranted(devVars, devVarsPresent)) return { allowed: true, provider, optIn: true };
  return { allowed: false, provider, message: refusalMessage({ devVarsPresent }) };
}

function refusalMessage({ devVarsPresent }) {
  const withFile = devVarsPresent
    ? `Your ${DEV_VARS_DISPLAY} does not grant it.`
    : `You have no ${DEV_VARS_DISPLAY} at all.`;
  return [
    `✖ pnpm dev blocked: EXECUTION_PROVIDER resolves to "modal" for this dev boot.`,
    ``,
    `apps/portal/wrangler.jsonc's top-level vars are the deployed staging worker's`,
    `configuration: EXECUTION_PROVIDER="modal" with the staging MODAL_RUNNER_URL.`,
    `Without a .dev.vars override, this dev boot would dispatch practice runs to`,
    `the REAL staging Modal runner. ${withFile}`,
    ``,
    `To develop against the safe fixture provider, copy apps/portal/.dev.vars.example`,
    `to apps/portal/.dev.vars and keep:`,
    ``,
    `  EXECUTION_PROVIDER="fixture"`,
    ``,
    `If — and only if — you genuinely need the real Modal runner locally, set BOTH`,
    `lines in your own apps/portal/.dev.vars:`,
    ``,
    `  EXECUTION_PROVIDER="modal"`,
    `  ${ALLOW_MODAL_EXECUTION_IN_DEV}="1"`,
    ``,
    `The opt-in flag is read only by this guard, never by the Worker. See the`,
    `"Running against the real Modal runner, locally" section in .dev.vars.example.`,
  ].join("\n");
}

function main() {
  const portalRoot = fileURLToPath(new URL("..", import.meta.url));
  const devVarsPath = process.env.COGPORTAL_DEV_GUARD_DEV_VARS ?? `${portalRoot}/.dev.vars`;
  const wranglerConfigPath = process.env.COGPORTAL_DEV_GUARD_WRANGLER_JSONC ?? `${portalRoot}/wrangler.jsonc`;

  let devVars = {};
  let devVarsPresent = false;
  if (existsSync(devVarsPath)) {
    try {
      devVars = parseDevVars(readFileSync(devVarsPath, "utf8"));
      devVarsPresent = true;
    } catch (error) {
      console.error(`✖ dev-execution-provider guard: could not read ${devVarsPath}: ${error.message}`);
      console.error("  Refusing to start (fail closed).");
      process.exit(1);
    }
  }

  let configVars;
  try {
    const config = parseJsonc(readFileSync(wranglerConfigPath, "utf8"));
    configVars = config && typeof config.vars === "object" && config.vars !== null ? config.vars : {};
  } catch (error) {
    console.error(`✖ dev-execution-provider guard: could not read or parse ${wranglerConfigPath}: ${error.message}`);
    console.error("  Refusing to start (fail closed).");
    process.exit(1);
  }

  const result = evaluateDevProviderGuard({ devVars, devVarsPresent, configVars });
  if (!result.allowed) {
    console.error(result.message);
    process.exit(1);
  }
  console.log(`✓ dev guard: EXECUTION_PROVIDER=${result.provider}${result.optIn ? ` (${ALLOW_MODAL_EXECUTION_IN_DEV} opt-in)` : ""}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
