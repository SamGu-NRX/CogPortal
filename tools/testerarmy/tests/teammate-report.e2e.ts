import { test } from '@e2e-dev/web';
import { expect, unique } from 'e2e';
import { randomUUID } from 'node:crypto';
import { CliHome } from '../support/cli.ts';
import { findAttemptDevice, revokeAttemptDevice, type AttemptDevice } from '../support/devices.ts';
import { STUDENT, TEAMMATE, approveDevice, browserPortal, cliDevices, devLogin, startLink } from '../support/link.ts';
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
// teammate should be able to read it in that run's row. After the oracle, the
// first three notes must also be visible and uncovered where they render.
//
// Tagged week3-report and left out of `npm test`, because it needs the Week 3
// benchmark checkout, its cached data and a course Python environment
// (support/week3.ts). `npm run test:week3-report` runs it. It was written
// red against 3670e55, whose local-report rows dropped the diagnostic; the
// rows show it since fix/local-report-notes-20261003 (PR89).

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
  { timeout: 300_000, tags: ['week3-report'] },
  async ({ app, agent, browser, screen }) => {
    const home = await CliHome.create({ benchmark: await week3Setup() });
    const portal = browserPortal(browser);
    // A name only this attempt uses, so teardown can find its device even if
    // the CLI collected its token and then failed (support/devices.ts).
    const deviceName = `E2E pilot ${randomUUID().slice(0, 8)}`;
    let attempt: AttemptDevice | undefined;
    let deviceId: string | undefined;
    let completed = false;
    try {
      const link = await startLink(home);
      await app.open('/');
      expect(await devLogin(browser, STUDENT)).toBe(200);
      attempt = { login: STUDENT, before: (await cliDevices(browser)).map((device) => device.id), name: deviceName };
      expect(await approveDevice(browser, link.code, deviceName)).toBe(200);
      const linkExit = await link.cli.exited(60_000);
      // Found before the exit code is judged: a CLI that failed after
      // collecting its token still left this device on the portal.
      deviceId = await findAttemptDevice(portal, attempt);
      expect(linkExit, link.cli.output()).toBe(0);
      expect(deviceId, 'this attempt created its device').toBeTruthy();

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

      // Present in the row is not the same as readable: text in a closed
      // fold is in the markup too. Each of the first three notes, verbatim
      // from the API record, must be visible in the row, and the browser
      // must find that note at its own position, so nothing (the sticky
      // header, a fold) covers it.
      await row.scrollIntoView();
      const shownNotes = brokenReport.diagnostics.slice(0, 3);
      for (const note of shownNotes) await expect(row.getByText(note)).toBeVisible();
      const placement = await browser.evaluate(
        (notes: string[]) =>
          notes.map((note) => {
            const element = Array.from(document.querySelectorAll('tbody td p, tbody td li span')).find(
              (each) => each.textContent === note,
            );
            if (!element) return 'missing';
            if (element.closest('[inert], [aria-hidden="true"]')) return 'folded';
            element.scrollIntoView({ block: 'center' });
            const box = element.getBoundingClientRect();
            if (box.top < 0 || box.bottom > window.innerHeight) return 'outside the viewport';
            const hit = document.elementFromPoint(box.left + Math.min(8, box.width / 2), box.top + box.height / 2);
            return hit && element.contains(hit) ? 'readable' : `covered by ${hit?.tagName.toLowerCase() ?? 'nothing'}`;
          }),
        shownNotes,
      );
      expect(placement).toEqual(shownNotes.map(() => 'readable'));
      await app.screenshot('teammate-row');
      completed = true;
    } finally {
      // Stop the CLI first, so it can't collect a token after the revoke.
      // Then revoke this attempt's device and no other: the recorded id, or
      // the one carrying this attempt's name if the body stopped before it
      // was recorded. A failed revoke fails a test that otherwise passed;
      // after an earlier failure it is printed, so it doesn't hide that one.
      const closed = await home.close().then(
        () => undefined,
        (error: unknown) => error,
      );
      const problem = attempt ? await revokeAttemptDevice(portal, attempt, deviceId) : undefined;
      if (closed) throw closed;
      if (problem) {
        const message = `Teardown could not revoke this attempt's device: ${problem}`;
        if (completed) throw new Error(message);
        console.error(message);
      }
    }
  },
);
