import { createEnv } from "@t3-oss/env-core";

export { createEnv };

/**
 * Shared t3-env plumbing for the CogWorks monorepo.
 *
 * The apps own their own schemas (their env shapes are disjoint); this package
 * only carries the wiring so every consumer validates the same way.
 *
 * Cloudflare Workers do not expose the environment on `process.env`. Each
 * request receives its own `env` binding object, so validation cannot happen at
 * module load (there is nothing to read yet) — it must happen per request with
 * that object passed as t3-env's `runtimeEnv`. `perRequestEnv` wraps a builder
 * so each distinct `env` object is validated at most once (memoized by object
 * identity via a WeakMap), which in a warm isolate is effectively once.
 */
export function perRequestEnv<TResult>(
  build: (runtimeEnv: Record<string, string | undefined>) => TResult,
): (runtimeEnv: object) => TResult {
  const cache = new WeakMap<object, TResult>();
  return (runtimeEnv: object): TResult => {
    const cached = cache.get(runtimeEnv);
    if (cached !== undefined) return cached;
    const built = build(runtimeEnv as Record<string, string | undefined>);
    cache.set(runtimeEnv, built);
    return built;
  };
}
