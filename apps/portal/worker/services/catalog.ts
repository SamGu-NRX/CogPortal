import { asc, desc } from "drizzle-orm";
import type { Benchmark } from "@cogworks/contracts/schema";
import type { Env } from "../env";
import { getDb } from "../db/client";
import { benchmarks } from "../db/schema";
import { serializeBenchmark } from "../http/serializers";

export async function listBenchmarks(env: Env): Promise<Benchmark[]> {
  const rows = await getDb(env)
    .select()
    .from(benchmarks)
    .orderBy(desc(benchmarks.active), asc(benchmarks.module), asc(benchmarks.title));
  return rows.map(serializeBenchmark);
}
