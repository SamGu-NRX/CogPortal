import { readdir, readFile, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../dist/", import.meta.url));
const secretFilenames = new Set([
  ".dev.vars",
  ".env",
  ".env.local",
  ".env.production",
]);
const secretPatterns = [
  /(?:DISCORD_BOT_TOKEN|DISCORD_CLIENT_SECRET|GITHUB_CLIENT_SECRET|ACTIVITY_SESSION_SECRET)\s*=\s*[^\s"'`]{8,}/,
  /[A-Za-z0-9_-]{20,32}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{25,50}/,
];

async function filesUnder(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await filesUnder(path));
    else files.push(path);
  }
  return files;
}

let files;
try {
  files = await filesUnder(root);
} catch (error) {
  if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") process.exit(0);
  throw error;
}

// Cloudflare's local preview bundle may copy .dev.vars even though it is not
// an asset. Remove that generated preview metadata before the deploy guard.
for (const file of files) {
  if (secretFilenames.has(basename(file))) await rm(file, { force: true });
}

files = await filesUnder(root);
const violations = [];
for (const file of files) {
  if (secretFilenames.has(basename(file))) {
    violations.push(file);
    continue;
  }
  const content = await readFile(file);
  const text = content.toString("utf8");
  if (secretPatterns.some((pattern) => pattern.test(text))) violations.push(file);
}

if (violations.length) {
  throw new Error(`Build blocked: possible secret material in ${violations.map((file) => file.replace(root, "dist/")).join(", ")}`);
}
