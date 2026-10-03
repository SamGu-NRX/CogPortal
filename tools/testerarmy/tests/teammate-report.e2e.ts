import { test } from '@e2e-dev/web';
import { expect, unique } from 'e2e';
import { CliHome } from '../support/cli.ts';
import { STUDENT, TEAMMATE, approveDevice, cliDevices, devLogin, revokeDevice, startLink } from '../support/link.ts';
import {
  BENCHMARK,
  ONE_DIMENSIONAL_EMBED_TEXT,
  createTeamRepo,
  localReports,
  runAndSync,
  week3Setup,
} from '../support/week3.ts';

// A student checks, runs and syncs the Week 3 benchmark from a team
// repository: once with the reference submission, then after a commit with
// an ordinary bug (embed_text averages over the wrong axis). The teammate
// then looks for that second run. The CLI, the reports and the team API are
// checked deterministically. The agent only finds the run on the page and
// says where, if anywhere, the page explains its low score; its reading is
// printed, never trusted. The benchmark's own diagnostic is the oracle: the
// teammate should be able to read it in that run's row.
//
// Tagged open-finding: on 3670e55 the local-report list drops diagnostics,
// so this test is red until the list shows them. `npm test` leaves it out;
// `npm run test:open-findings` runs it.

/** The agent's reading of the page. */
type Reading = { explanation: string | null; where: string | null };
const READING_SHAPE = {
  type: 'object',
  properties: {
    explanation: { type: ['string', 'null'], description: 'The page text that explains the low score, quoted, or null.' },
    where: { type: ['string', 'null'], description: 'Where on the page that text is, or null.' },
  },
  required: ['explanation', 'where'],
  additionalProperties: false,
};
const isTextOrNull = (value: unknown): value is string | null => value === null || typeof value === 'string';
// Standard Schema v1 by hand: zod is only a transitive dependency here. The
// `jsonSchema` converter is what the AI SDK projects, so the model gets the shape.
const readingSchema = {
  '~standard': {
    version: 1 as const,
    vendor: 'cogportal-pilot',
    validate(value: unknown) {
      if (typeof value === 'object' && value !== null && 'explanation' in value && 'where' in value) {
        const { explanation, where } = value;
        if (isTextOrNull(explanation) && isTextOrNull(where)) return { value: { explanation, where } satisfies Reading };
      }
      return { issues: [{ message: 'expected { explanation: string | null, where: string | null }' }] };
    },
    jsonSchema: { input: () => READING_SHAPE, output: () => READING_SHAPE },
  },
};

test(
  'a teammate finds the run a student synced and can read why it scored low',
  { timeout: 300_000, tags: ['open-finding'] },
  async ({ app, agent, browser, screen }) => {
    const home = await CliHome.create({ benchmark: await week3Setup() });
    let deviceId: string | undefined;
    let completed = false;
    try {
      const link = await startLink(home);
      await app.open('/');
      expect(await devLogin(browser, STUDENT)).toBe(200);
      const devicesBefore = (await cliDevices(browser)).map((device) => device.id);
      expect(await approveDevice(browser, link.code)).toBe(200);
      expect(await link.cli.exited(60_000), link.cli.output()).toBe(0);
      const approved = (await cliDevices(browser)).filter((device) => !devicesBefore.includes(device.id));
      expect(approved, 'this attempt approved exactly one device').toHaveLength(1);
      // SAFETY: toHaveLength(1) above throws unless there is exactly one.
      deviceId = approved[0]!.id;

      const repo = await createTeamRepo(home.path);
      const check = home.start(['check', '--benchmark', BENCHMARK, '--update-setup'], { cwd: repo.path });
      expect(await check.exited(120_000), check.output()).toBe(0);
      const reference = await runAndSync(home, repo);
      await repo.commitBrokenEmbedText();
      const broken = await runAndSync(home, repo);

      // What the teammate's account can read through the API.
      expect(await devLogin(browser, TEAMMATE)).toBe(200);
      const reports = await localReports(browser);
      const listed = (reportId: string) => {
        const report = reports.find((each) => each.reportId === reportId);
        if (!report) throw new Error(`The team API does not list ${reportId}.`);
        return report;
      };
      const brokenReport = listed(broken.reportId);
      const referenceReport = listed(reference.reportId);
      const synced = { benchmarkId: BENCHMARK, benchmarkVersion: 1, dirty: false, command: 'run' };
      expect(brokenReport).toMatchObject({ ...synced, sha: broken.sha });
      expect(referenceReport).toMatchObject({ ...synced, sha: reference.sha });
      expect(brokenReport.diagnostics.some((note) => note.includes(ONE_DIMENSIONAL_EMBED_TEXT))).toBe(true);
      expect(referenceReport.diagnostics.some((note) => note.includes(ONE_DIMENSIONAL_EMBED_TEXT))).toBe(false);

      // The teammate finds the run on the page.
      const commit = broken.sha.slice(0, 7);
      await app.open('/');
      await agent.act('find the run your teammate synced from their own machine for commit {commit}', {
        params: { commit: unique(commit) },
        maxSteps: 10,
        maxModelCalls: 12,
        timeout: 120_000,
      });
      const row = screen.getByRole('row', { name: new RegExp(commit) });
      await expect(row).toBeVisible();
      await expect(row).toContainText('run');

      const reading = await agent.extract(
        `Quote the text on this page that explains why the run for commit ${commit} scored low, and say where it is. ` +
          'Use null for both when the page shows no explanation.',
        { schema: readingSchema },
      );
      console.log(`Agent's reading of the page (not evidence): ${JSON.stringify(reading)}`);

      // The oracle: the benchmark's diagnostic in this run's own row. Commits
      // take the current time, so no earlier attempt's report shares the row.
      await expect(row).toContainText(ONE_DIMENSIONAL_EMBED_TEXT);
      completed = true;
    } finally {
      // This attempt's device and no other, whatever happened above. A failed
      // revoke fails a test that otherwise passed; after an earlier failure it
      // is printed, so it doesn't hide that failure.
      const revoked = deviceId
        ? await revokeDevice(browser, STUDENT, deviceId).catch((error: unknown) => String(error))
        : 200;
      await home.close();
      if (revoked !== 200) {
        const message = `Teardown could not revoke this attempt's device ${deviceId}: ${revoked}`;
        if (completed) throw new Error(message);
        console.error(message);
      }
    }
  },
);
