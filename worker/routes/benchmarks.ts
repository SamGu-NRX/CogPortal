import type { Hono } from "hono";
import { asc, desc } from "drizzle-orm";
import { z } from "zod";
import { BenchmarkSchema } from "@shared/schema";
import type { AppEnv } from "../env";
import { getDb } from "../db/client";
import { benchmarks } from "../db/schema";
import { serializeBenchmark } from "../http/serializers";
import { respond } from "../http/respond";

export function registerBenchmarkRoutes(app: Hono<AppEnv>): void {
  app.get("/benchmarks", async (c) => {
    const rows = await getDb(c.env)
      .select()
      .from(benchmarks)
      .orderBy(desc(benchmarks.active), asc(benchmarks.module), asc(benchmarks.title));
    return respond(c, z.array(BenchmarkSchema), rows.map(serializeBenchmark));
  });
}
