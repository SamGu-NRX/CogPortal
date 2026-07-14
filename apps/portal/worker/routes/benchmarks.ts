import type { Context, Hono } from "hono";
import { z } from "zod";
import { BenchmarkSchema } from "@cogworks/contracts/schema";
import type { AppEnv } from "../env";
import { respond } from "../http/respond";
import { listBenchmarks } from "../services/catalog";

export function registerBenchmarkRoutes(app: Hono<AppEnv>): void {
  const handler = async (c: Context<AppEnv>) =>
    respond(c, z.array(BenchmarkSchema), await listBenchmarks(c.env));
  app.get("/benchmarks", handler);
  app.get("/v1/benchmarks", handler);
}
