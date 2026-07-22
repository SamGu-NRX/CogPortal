import type { PortalRpcContract } from "@cogworks/contracts/discord";
import { createEnv, perRequestEnv } from "@cogworks/env";
import { z } from "zod";

export interface Bindings {
  PORTAL: PortalRpcContract;
}

const serverSchema = {
  DISCORD_PUBLIC_KEY: z.string().min(1),
  COURSE_GUILD_ID: z.string().min(1),
  PORTAL_ORIGIN: z.string().optional(),
} satisfies Record<string, z.ZodType>;

export const validateBotEnv = perRequestEnv((runtimeEnv) =>
  createEnv({
    server: serverSchema,
    runtimeEnv,
    emptyStringAsUndefined: true,
    isServer: true,
  }),
);

export type ServerEnv = ReturnType<typeof validateBotEnv>;
export type Env = Bindings & ServerEnv;
