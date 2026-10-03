import type { E2EConfig } from 'e2e';
import { web } from '@e2e-dev/web';
import { chatgpt } from 'e2e/oauth/chatgpt';
import { LOCAL_ORIGIN } from './support/local-origin.ts';

// TesterArmy pilot against a local portal. The dev server is started outside
// the runner (its own D1, seeded, on port 5195) so every comparison run in a
// series talks to the same process; the runner never starts or stops it.
// LOCAL_ORIGIN refuses any APP_URL that isn't a loopback origin.

export default {
  projectId: 'cogportal-testerarmy-pilot',
  // One attempt per test and one browser at a time: the pilot measures what a
  // single run costs, and a retry would replay live and blur the cache counts.
  retries: 0,
  workers: 1,
  // Bounds, not tuned values. A model step is slower than a Playwright
  // action, so the attempt budget is wider than the framework's 120 s
  // default; each act also carries its own smaller timeout in the test.
  timeout: 180_000,
  actionTimeout: 15_000,
  assertionTimeout: 10_000,
  // Traces hold screenshots; keep them only when an attempt fails, under the
  // gitignored output directory.
  trace: 'retain-on-failure',
  reporters: ['list', 'junit', 'markdown'],
  agents: {
    // One model and no fallback: a run uses it or fails. `judge` is unset,
    // so assert/extract use the same model.
    default: { model: chatgpt('gpt-6-luna'), maxSteps: 12, maxModelCalls: 12 },
  },
  // A series sets PILOT_CACHE_DIR to a fresh directory so its cold run starts
  // from an empty cache and its later runs read the same one.
  cache: { mode: 'read-write', dir: process.env.PILOT_CACHE_DIR ?? '.e2e/cache' },
  targets: [
    {
      name: 'chromium-1280',
      engine: web({ browser: 'chromium', viewport: { width: 1280, height: 900 } }),
      app: { url: LOCAL_ORIGIN },
    },
  ],
} satisfies E2EConfig;
