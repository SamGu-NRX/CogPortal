import { test } from '@e2e-dev/web';
import { expect } from 'e2e';

// A signed-out visitor finds this year's results from the landing
// page. The replay cache keys on the test name and the instruction, so both
// stay fixed across a comparison series. Two switches vary a run on purpose:
//
//   PILOT_EXPECT_HEADING  The heading the board must show. The wrong-outcome
//                         run sets one the page doesn't show ("Audio" is a
//                         track that isn't open yet) and must fail.
//   PILOT_RENAME_LINK     The visible text of a link to rename in the page
//                         before the step (the control the recording clicked),
//                         so the replay can't find it. Product code is not
//                         touched; the rename lives only in this browser tab.
//
// With the local seed the board opens on Vision: Recognition and Clustering
// are both active and Audio isn't (LeaderboardPage.tsx, the `opening` track).
const expectedHeading = process.env.PILOT_EXPECT_HEADING ?? 'Vision';
const renameLink = process.env.PILOT_RENAME_LINK;
const RENAMED = 'Browse the published results';

test("a signed-out visitor opens this year's results from the landing page", async ({
  app,
  agent,
  browser,
  screen,
}) => {
  await app.open('/');
  await expect(screen.getByRole('heading', { level: 1 })).toContainText('capstone');

  if (renameLink) {
    const renamed = await browser.evaluate(
      (arg: { from: string; to: string }) => {
        for (const link of Array.from(document.querySelectorAll('a'))) {
          const walker = document.createTreeWalker(link, NodeFilter.SHOW_TEXT);
          for (let node = walker.nextNode(); node; node = walker.nextNode()) {
            if (node.textContent?.trim() === arg.from) {
              node.textContent = arg.to;
              return true;
            }
          }
        }
        return false;
      },
      { from: renameLink, to: RENAMED },
    );
    expect(renamed).toBe(true);
    await expect(screen.getByRole('link', { name: RENAMED })).toBeVisible();
  }

  await agent.act("open this year's published results", {
    maxSteps: 6,
    maxModelCalls: 8,
    timeout: 90_000,
  });

  // Deterministic checks of the outcome; these also confirm the recording.
  await expect(browser).toHaveURL('/leaderboard');
  await expect(screen.getByRole('heading', { name: expectedHeading, level: 1 })).toBeVisible();
  await expect(screen.getByText('Published results')).toBeVisible();
});
