#!/usr/bin/env node
/**
 * Asks CodeRabbit to review open pull requests whose head commit it never reviewed.
 *
 * Why this exists: on the free tier CodeRabbit refuses a review when the account is
 * over its hourly allowance. It records the refusal as a *passing* commit status, so
 * nothing in the GitHub UI looks wrong, and the head stays unreviewed until somebody
 * comments "@coderabbitai review". Nobody did, so most open pull requests here have
 * unreviewed heads. This script is that somebody, on a schedule.
 *
 * How it knows: CodeRabbit reports through the legacy commit status API under the
 * context "CodeRabbit", not the Checks API. /commits/{sha}/check-runs is empty for
 * every commit in this repository, and the CodeRabbit check *suite* sits at "queued"
 * forever, so anything keyed on check runs sees nothing. /commits/{sha}/status carries
 * one CodeRabbit status whose `state` is "success" both when a review finished and
 * when one was refused; only `description` separates them. Observed values:
 *
 *   pending  "Review queued"
 *   pending  "Review in progress"
 *   success  "Review completed"                                     <- reviewed
 *   success  "Review rate limited"                                  <- refused
 *   success  "Review skipped: reviews are disabled for this base branch"
 *
 * The last one covers 34 of the 37 open pull requests: they are stacked on each other
 * rather than on main, and their branches predate .coderabbit.yaml. An explicit
 * "@coderabbitai review" comment overrides it. Pull request #20 is the proof: its head
 * carried the base-branch skip at 07:45:36, a bare "@coderabbitai review" comment
 * landed at 08:17:55, and CodeRabbit moved the same head to "Review in progress" at
 * 08:18:04.
 *
 * Environment: DRY_RUN=1 decides and logs without commenting. ONLY_PR=<n> restricts
 * the run to one pull request. GITHUB_REPOSITORY overrides the repository. Auth comes
 * from `gh`, which reads GH_TOKEN when it is set.
 */

import { execFileSync } from 'node:child_process';

const REPO = process.env.GITHUB_REPOSITORY || 'SamGu-NRX/CogPortal';
const DRY_RUN = /^(1|true|yes)$/i.test(process.env.DRY_RUN || '');
const ONLY_PR = process.env.ONLY_PR ? Number(process.env.ONLY_PR) : null;

const REVIEW_COMMAND = '@coderabbitai review';

/** Each run asks for at most this many reviews, so one run cannot drain the free-tier allowance. */
const MAX_REQUESTS_PER_RUN = 3;

/**
 * A rate-limited request is refused rather than served, so the head is still unreviewed
 * and the queue retries it. This caps the retries so a permanently rate-limited head
 * cannot accumulate comments; past the cap the run logs it for a human.
 */
const MAX_ATTEMPTS_PER_HEAD = 3;

/**
 * A "pending" CodeRabbit status means a review is running, and asking again would be a
 * duplicate. Every pending-to-final transition on record here took under four minutes
 * (2s on #20, 9s on #1, 1m51s on #39, 3m45s on #38), so a pending status older than this
 * is a stalled review rather than a live one.
 */
const PENDING_STALE_MS = 30 * 60 * 1000;

function gh(args) {
  try {
    return execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  } catch (error) {
    const detail = String(error.stderr || error.message || '').trim();
    throw new Error(`gh ${args.join(' ')} failed: ${detail}`);
  }
}

function api(path, extra = []) {
  return JSON.parse(gh(['api', '-H', 'Accept: application/vnd.github+json', path, ...extra]));
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function openPullRequests() {
  const all = [];
  for (let page = 1; ; page += 1) {
    const batch = api(`repos/${REPO}/pulls?state=open&per_page=100&page=${page}`);
    all.push(...batch);
    if (batch.length < 100) return all;
  }
}

/** The combined-status endpoint returns the current status per context, so find() is the latest. */
function codeRabbitStatus(sha) {
  const combined = api(`repos/${REPO}/commits/${sha}/status?per_page=100`);
  return combined.statuses.find((status) => status.context === 'CodeRabbit') || null;
}

/**
 * The earlier of the commit's author and committer dates. Biasing early makes existing
 * request comments more likely to count as "newer than the head", which errs toward
 * skipping rather than toward asking twice for the same head.
 */
function headCommittedAt(sha) {
  const commit = api(`repos/${REPO}/commits/${sha}`).commit;
  const dates = [commit.author?.date, commit.committer?.date]
    .filter(Boolean)
    .map((date) => Date.parse(date));
  return Math.min(...dates);
}

/**
 * Review-request comments posted after the head commit, oldest first. The `since`
 * parameter filters on updated_at, so created_at is re-checked here. "@coderabbitai
 * full review" is a different command and does not match this prefix.
 */
function reviewRequestsSinceHead(number, headAt) {
  const since = encodeURIComponent(new Date(headAt).toISOString());
  const comments = api(`repos/${REPO}/issues/${number}/comments?per_page=100&since=${since}`);
  return comments
    .filter((comment) => Date.parse(comment.created_at) > headAt)
    .filter((comment) => (comment.body || '').trim().toLowerCase().startsWith(REVIEW_COMMAND))
    .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
}

/** Mergeability is computed on demand, so a null answer is retried once before giving up. */
async function mergeable(number) {
  for (const wait of [0, 4000]) {
    if (wait) await sleep(wait);
    const detail = api(`repos/${REPO}/pulls/${number}`);
    if (detail.mergeable !== null) return detail.mergeable;
  }
  return null;
}

async function decide(pr) {
  const sha = pr.head.sha;

  if (pr.draft) {
    return { action: 'skip', reason: 'draft, so the author is still working on it' };
  }

  const canMerge = await mergeable(pr.number);
  if (canMerge === false) {
    return { action: 'skip', reason: 'conflicts with its base branch' };
  }
  if (canMerge === null) {
    return { action: 'skip', reason: 'GitHub has not computed mergeability yet, so the next run retries' };
  }

  const status = codeRabbitStatus(sha);
  const description = status?.description || '';

  if (status && status.state === 'pending') {
    const age = Date.now() - Date.parse(status.created_at);
    if (age < PENDING_STALE_MS) {
      return { action: 'skip', reason: `CodeRabbit is working on this head ("${description}")` };
    }
  }

  if (status && status.state === 'success' && /^review completed/i.test(description)) {
    return { action: 'skip', reason: 'CodeRabbit already reviewed this head' };
  }

  const headAt = headCommittedAt(sha);
  const requests = reviewRequestsSinceHead(pr.number, headAt);

  if (requests.length > 0) {
    const last = requests[requests.length - 1];
    // A request answered with "Review rate limited" was refused, not served, so it left
    // the head unreviewed and does not count as an outstanding request.
    const refused =
      status &&
      status.state === 'success' &&
      /rate limited/i.test(description) &&
      Date.parse(status.created_at) > Date.parse(last.created_at);

    if (!refused) {
      return {
        action: 'skip',
        reason: `${last.user.login} already asked on ${last.created_at}`,
        headAt,
      };
    }
    if (requests.length >= MAX_ATTEMPTS_PER_HEAD) {
      return {
        action: 'skip',
        reason: `asked ${requests.length} times and CodeRabbit is still rate limited, so a human should look`,
        headAt,
      };
    }
  }

  const said = status ? `CodeRabbit last said "${description}"` : 'CodeRabbit never reported on this head';
  const again = requests.length > 0 ? `, and the last request was rate limited (attempt ${requests.length + 1})` : '';
  return { action: 'request', reason: `${said}${again}`, headAt };
}

function postRequest(number) {
  gh(['api', '-X', 'POST', `repos/${REPO}/issues/${number}/comments`, '-f', `body=${REVIEW_COMMAND}`]);
}

async function main() {
  const pulls = openPullRequests()
    .filter((pr) => ONLY_PR === null || pr.number === ONLY_PR)
    .sort((a, b) => a.number - b.number);

  if (ONLY_PR !== null && pulls.length === 0) {
    throw new Error(`pull request #${ONLY_PR} is not open`);
  }

  console.log(`review-queue: ${REPO}, ${pulls.length} open pull request(s)${DRY_RUN ? ', dry run' : ''}`);

  const decisions = [];
  for (const pr of pulls) {
    decisions.push({ pr, ...(await decide(pr)) });
  }

  // Oldest head first: the heads that have waited longest for a review go first.
  const eligible = decisions
    .filter((decision) => decision.action === 'request')
    .sort((a, b) => a.headAt - b.headAt);

  for (const decision of eligible.slice(MAX_REQUESTS_PER_RUN)) {
    decision.action = 'defer';
    decision.reason = `${decision.reason}, but this run already asked for ${MAX_REQUESTS_PER_RUN}`;
  }
  const chosen = eligible.slice(0, MAX_REQUESTS_PER_RUN);

  for (const decision of chosen) {
    if (DRY_RUN) continue;
    postRequest(decision.pr.number);
    decision.reason = `${decision.reason}; posted "${REVIEW_COMMAND}"`;
  }

  for (const decision of decisions) {
    const head = decision.pr.head.sha.slice(0, 7);
    const number = `#${decision.pr.number}`.padEnd(4);
    console.log(`${number} ${head} ${decision.action.padEnd(7)} ${decision.reason}`);
  }

  const counted = (action) => decisions.filter((decision) => decision.action === action).length;
  console.log(
    `review-queue: ${DRY_RUN ? 'would request' : 'requested'} ${chosen.length}, ` +
      `deferred ${counted('defer')}, skipped ${counted('skip')}`,
  );
}

main().catch((error) => {
  console.error(`review-queue: ${error.message}`);
  process.exit(1);
});
