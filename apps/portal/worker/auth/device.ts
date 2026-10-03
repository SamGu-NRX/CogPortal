import type { Context } from "hono";
import { and, eq, gt, isNull } from "drizzle-orm";
import type { AppEnv } from "../env";
import { getDb } from "../db/client";
import { cliDevices } from "../db/schema";
import { ApiHttpError } from "../http/errors";
import { sha256Hex } from "../util/crypto";

export interface DeviceAuth {
  deviceId: string;
  userId: string;
  name: string;
  expiresAt: number;
}

export async function requireDevice(c: Context<AppEnv>): Promise<DeviceAuth> {
  const authorization = c.req.header("Authorization");
  if (!authorization?.startsWith("Bearer cog_")) {
    throw new ApiHttpError(401, "invalid_token", "A linked CogBench device token is required.");
  }
  const token = authorization.slice("Bearer ".length);
  const db = getDb(c.env);
  const [device] = await db
    .select()
    .from(cliDevices)
    .where(
      and(
        eq(cliDevices.tokenHash, await sha256Hex(token)),
        gt(cliDevices.expiresAt, Date.now()),
        isNull(cliDevices.revokedAt),
      ),
    )
    .limit(1);
  if (!device) {
    throw new ApiHttpError(
      401,
      "invalid_token",
      "This CogWorks connection expired or was revoked. Run `cogworks link` to connect this machine again.",
    );
  }
  await db.update(cliDevices).set({ lastUsedAt: Date.now() }).where(eq(cliDevices.id, device.id));
  return { deviceId: device.id, userId: device.userId, name: device.name, expiresAt: device.expiresAt };
}
