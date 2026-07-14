import { defineConfig } from "drizzle-kit";

// Local generation only: `pnpm db:generate` writes SQL into ./migrations,
// which `wrangler d1 migrations apply` runs (locally against miniflare state,
// remotely against the real D1 database). No credentials needed to generate.
export default defineConfig({
  dialect: "sqlite",
  schema: "./worker/db/schema.ts",
  out: "./migrations",
});
