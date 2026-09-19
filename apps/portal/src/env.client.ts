import { createEnv } from "@cogworks/env";
import { z } from "zod";

// Vite inlines this browser-only value; runtime deployment config comes from
// /api/session because Worker bindings are unavailable at module load.
export const clientEnv = createEnv({
  clientPrefix: "VITE_",
  client: {
    VITE_DISCORD_CLIENT_ID: z.string().min(1).default("1526706029356646460"),
    // Defaults are the dev deployment; a production build overrides them at
    // build time (wrangler vars never reach this client bundle).
    VITE_PORTAL_ORIGIN: z.string().url().default("https://cogportal-dev.sillion.app"),
    VITE_ACTIVITY_HOSTNAME: z.string().min(1).default("cogactivity-dev.sillion.app"),
  },
  runtimeEnv: import.meta.env,
  emptyStringAsUndefined: true,
});
