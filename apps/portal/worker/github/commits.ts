import { githubApiRequest } from "./client";

/**
 * One commit as the process-signals service needs it: enough to attribute
 * file changes to a capstone stage and a person, nothing else. Mirrors
 * cogbench's `Commit` dataclass (python/cogbench/src/cogbench/process.py)
 * minus `insertions`/`deletions`, which process.py accepts as input but no
 * function there ever reads -- this instrument is indifferent to line
 * counts, so there is no reason to carry them across the fetch either.
 *
 * `authorLogin` is a plain `string`, matching process.py's `Commit.author_login: str`
 * (not optional) exactly. GitHub's API can return a null top-level `author`
 * when a commit's git identity has no linked GitHub account; process.py's
 * type does not model that because process.py never talks to GitHub itself
 * -- its caller was always assumed to hand over a real login. This module
 * *is* that caller, so it has to decide what to do with a null linked
 * account, and it falls back to the commit's own git author name (real data
 * already present on the same commit, not a guess standing in for it). See
 * `parseCommitDetail` below.
 */
export interface CommitRecord {
  sha: string;
  authorLogin: string;
  authoredAt: number;
  filesChanged: string[];
  /**
   * `Co-authored-by:` trailers exactly as the commit message wrote them,
   * unresolved. One 2026 student authored no commits under `authorLogin` and
   * co-authored three, because the team worked in a single editor session; to
   * every signal below they did not exist. Resolving a trailer to a person
   * needs the team roster, which this module has no access to, so the raw
   * trailer travels and `../services/process-signals.ts` decides who (if
   * anyone) it names.
   */
  coAuthors: CoAuthorTrailer[];
}

/** One `Co-authored-by: Name <email>` trailer, as written. */
export interface CoAuthorTrailer {
  name: string;
  email: string;
}

/**
 * Git trailer lines, matched case-insensitively on the key. A trailer whose
 * value is not `Something <address>` is not a co-author attribution and is
 * skipped; anything that survives here still has to resolve to a roster
 * member downstream, which is what keeps bots and strangers out without a
 * list of their names.
 */
const CO_AUTHOR_TRAILER = /^co-authored-by:\s*(.*?)\s*<([^>]+)>$/i;

export function parseCoAuthorTrailers(message: string): CoAuthorTrailer[] {
  const trailers: CoAuthorTrailer[] = [];
  for (const line of message.split("\n")) {
    const match = CO_AUTHOR_TRAILER.exec(line.trim());
    if (match) trailers.push({ name: match[1], email: match[2].trim() });
  }
  return trailers;
}

/**
 * Result of fetching a repository's commit history. `ok: false` carries a
 * `reason` that keeps four genuinely different situations apart:
 *
 * - `unauthorized`: GitHub rejected the user's sign-in token.
 * - `not_found`: the repo is gone or the token no longer has access to it.
 * - `rate_limited`: GitHub throttled the request; retry later.
 * - `fetch_failed`: anything else that stopped the fetch (network error,
 *   malformed response, unexpected status).
 *
 * None of these is "no history" -- that's `{ ok: true, commits: [] }`,
 * produced only when GitHub itself confirms the repository is empty. The
 * whole point of keeping this as a discriminated union instead of, say,
 * `commits: CommitRecord[] | null` is that a caller cannot accidentally
 * conflate "we looked and there's nothing" with "we couldn't look" -- see
 * the module docstring in `../services/process-signals.ts` and
 * `docs/design/the-instrument-not-the-judge.md` ("Never interpolate").
 */
export type FetchCommitsResult =
  | {
      ok: true;
      commits: CommitRecord[];
      /**
       * The repository has commits older than the ones returned. Callers must
       * not present a truncated window as the repository's whole history.
       */
      truncated: boolean;
    }
  | { ok: false; reason: "unauthorized" | "not_found" | "rate_limited" | "fetch_failed" };

/**
 * How many commits this reads, and why that number.
 *
 * One detail request per commit, and a Worker on the Free plan may make 50
 * external subrequests per invocation (Cloudflare's documented limit; the
 * separate internal-services pool that D1 draws on is 1,000, so database
 * queries here are not what runs out). Measured on the demo repository before
 * this cap existed: the list request plus 49 detail requests succeeded and the
 * 50th detail threw, at commit 50 of 75, with no HTTP status because the
 * platform refused the subrequest rather than GitHub refusing the call.
 *
 * So the budget is 50 external requests: one to list, 40 to read, and nine
 * spare. The spare is not padding. `getGithubToken` can refresh against GitHub
 * on the same invocation, and Cloudflare counts each hop of a redirect chain,
 * which a renamed repository produces.
 *
 * 300 was the old value and never fit. It was not reached on a small
 * repository, which is why this held together until a team had more than
 * about fifty commits.
 */
const MAX_COMMITS = 40;
const DETAIL_CONCURRENCY = 8;
/** Larger than MAX_COMMITS on purpose: one list request answers the whole
 *  window and still reveals whether older commits exist. */
const PER_PAGE = 100;

function isRateLimited(response: Response): boolean {
  if (response.status === 429) return true;
  if (response.status !== 403) return false;
  // GitHub's primary rate limit surfaces as a 403 with `x-ratelimit-remaining: 0`;
  // its secondary (abuse-detection) limit is also a 403, without that header.
  // Either way, by the time this module fetches commits the caller already
  // held a token good enough to read the repo (routes/team.ts validated that
  // when the repo was connected), so a fresh 403 here is GitHub throttling
  // us, not the token having lost access -- treat every 403 as rate limiting.
  return true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseCommitDetail(value: unknown): CommitRecord | null {
  if (!isRecord(value)) return null;
  const sha = value.sha;
  if (typeof sha !== "string") return null;
  const commit = value.commit;
  if (!isRecord(commit)) return null;
  const commitAuthor = commit.author;
  if (!isRecord(commitAuthor)) return null;
  const authoredAtRaw = commitAuthor.date;
  const gitAuthorName = commitAuthor.name;
  if (typeof authoredAtRaw !== "string" || typeof gitAuthorName !== "string") return null;
  const authoredAt = Date.parse(authoredAtRaw);
  if (Number.isNaN(authoredAt)) return null;

  const topAuthor = value.author;
  const linkedLogin =
    isRecord(topAuthor) && typeof topAuthor.login === "string" ? topAuthor.login : null;

  const files = value.files;
  const filesChanged = Array.isArray(files)
    ? files
        .map((file) => (isRecord(file) && typeof file.filename === "string" ? file.filename : null))
        .filter((name): name is string => name !== null)
    : [];

  const message = commit.message;

  return {
    sha,
    authorLogin: linkedLogin ?? gitAuthorName,
    authoredAt,
    filesChanged,
    coAuthors: typeof message === "string" ? parseCoAuthorTrailers(message) : [],
  };
}

/**
 * Fetches a repository's commit history with per-commit changed files.
 *
 * GitHub's list-commits endpoint (`GET /repos/{owner}/{repo}/commits`) does
 * not include file diffs, so getting per-commit files needs a second call.
 * There are two candidates for that second call:
 *
 * 1. Per-commit detail (`GET /repos/{owner}/{repo}/commits/{sha}`), which
 *    returns that one commit's own `files` array.
 * 2. The compare endpoint (`GET .../compare/{base}...{head}`), which
 *    returns commits *and* files in one call.
 *
 * This uses (1). The compare endpoint's `files` array is the *merged* diff
 * across the whole range between base and head, not one list per commit --
 * ten commits touching ten different stages would collapse into a single
 * undifferentiated file list, which destroys the per-commit stage
 * attribution `stageFootprint` depends on. Per-commit detail is the only
 * strategy that keeps each commit's files separate, so that's what this
 * does: list-commits for the shas, then one detail call per sha, capped at
 * MAX_COMMITS and bounded to DETAIL_CONCURRENCY concurrent requests so a
 * large history doesn't fan out into hundreds of simultaneous calls.
 */
export async function fetchCommitHistory(
  fullName: string,
  defaultBranch: string,
  token: string,
): Promise<FetchCommitsResult> {
  const [owner, name] = fullName.split("/");
  if (!owner || !name) return { ok: false, reason: "fetch_failed" };

  const shas: string[] = [];
  let truncated = false;
  // Where the detail requests go. A repository that has been renamed answers
  // its old name with a redirect, and Cloudflare counts every hop against the
  // same 50, so paying one per commit would cost 82 requests for a 40-commit
  // window and fail before finishing. The list response below has already
  // followed the redirect, so its final URL names the repository once and the
  // detail requests go straight there.
  let detailOwner = owner;
  let detailName = name;
  for (let page = 1; shas.length < MAX_COMMITS; page += 1) {
    let response: Response;
    try {
      response = await githubApiRequest(
        `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/commits` +
          `?sha=${encodeURIComponent(defaultBranch)}&per_page=${PER_PAGE}&page=${page}`,
        token,
      );
    } catch {
      console.warn(JSON.stringify({ evt: "commit_list_fetch_failed", repo: fullName, page }));
      return { ok: false, reason: "fetch_failed" };
    }

    // Only from the first page, and only when it actually moved.
    if (page === 1 && response.url) {
      const moved = /\/repos\/([^/]+)\/([^/?]+)\/commits/.exec(response.url);
      if (moved && (moved[1] !== owner || moved[2] !== name)) {
        detailOwner = decodeURIComponent(moved[1]);
        detailName = decodeURIComponent(moved[2]);
        console.warn(
          JSON.stringify({
            evt: "commit_repo_redirected",
            from: fullName,
            to: `${detailOwner}/${detailName}`,
          }),
        );
      }
    }

    if (response.status === 409) {
      // GitHub's exact response for a repository with zero commits is a 409
      // with body `{"message": "Git Repository is empty."}`. This is a
      // confirmed, real state -- a team that hasn't pushed yet -- and must
      // return `{ ok: true, commits: [] }`, never `fetch_failed`. Treating
      // it as a failure would make "hasn't started" indistinguishable from
      // "GitHub access broke," which is exactly the conflation this result
      // type exists to prevent.
      return { ok: true, commits: [], truncated: false };
    }
    if (response.status === 401) return { ok: false, reason: "unauthorized" };
    if (response.status === 404) return { ok: false, reason: "not_found" };
    if (isRateLimited(response)) return { ok: false, reason: "rate_limited" };
    if (!response.ok) {
      console.warn(
        JSON.stringify({
          evt: "commit_list_fetch_failed",
          repo: fullName,
          page,
          status: response.status,
        }),
      );
      return { ok: false, reason: "fetch_failed" };
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      return { ok: false, reason: "fetch_failed" };
    }
    if (!Array.isArray(payload)) return { ok: false, reason: "fetch_failed" };
    if (payload.length === 0) break;

    // More entries on this page than the window takes means older commits
    // exist. A full page means the same, since a further page was not read.
    if (payload.length > MAX_COMMITS - shas.length || payload.length === PER_PAGE) {
      truncated = true;
    }
    for (const entry of payload) {
      if (!isRecord(entry) || typeof entry.sha !== "string") {
        return { ok: false, reason: "fetch_failed" };
      }
      shas.push(entry.sha);
      if (shas.length >= MAX_COMMITS) break;
    }
    if (payload.length < PER_PAGE) break;
  }

  if (shas.length === 0) return { ok: true, commits: [], truncated: false };

  const commits: (CommitRecord | null)[] = new Array(shas.length).fill(null);
  let unauthorized = false;
  let rateLimited = false;
  let failed = false;
  let cursor = 0;

  async function worker(): Promise<void> {
    while (cursor < shas.length && !unauthorized && !rateLimited && !failed) {
      const index = cursor;
      cursor += 1;
      const sha = shas[index];
      let response: Response;
      try {
        response = await githubApiRequest(
          `/repos/${encodeURIComponent(detailOwner)}/${encodeURIComponent(detailName)}/commits/${sha}`,
          token,
        );
      } catch (error) {
        // Name the cause. Without it this line said only that a fetch threw,
        // and the two candidates want opposite fixes: the platform's
        // per-request subrequest ceiling means asking for less, while the
        // 10-second AbortSignal in githubApiRequest means asking again.
        // Only the message is logged; the request carries a token.
        console.warn(
          JSON.stringify({
            evt: "commit_detail_fetch_failed",
            repo: fullName,
            sha,
            cause: error instanceof Error ? `${error.name}: ${error.message}` : "unknown",
          }),
        );
        failed = true;
        return;
      }
      if (response.status === 401) {
        unauthorized = true;
        return;
      }
      if (isRateLimited(response)) {
        rateLimited = true;
        return;
      }
      if (!response.ok) {
        console.warn(
          JSON.stringify({
            evt: "commit_detail_fetch_failed",
            repo: fullName,
            sha,
            status: response.status,
          }),
        );
        failed = true;
        return;
      }
      let detail: unknown;
      try {
        detail = await response.json();
      } catch {
        failed = true;
        return;
      }
      const record = parseCommitDetail(detail);
      if (!record) {
        failed = true;
        return;
      }
      commits[index] = record;
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(DETAIL_CONCURRENCY, shas.length) }, () => worker()),
  );

  // A fetch that broke partway is never returned as if it had finished. A
  // team's history quality (`usable` vs `bulk_upload`) is decided from totals
  // over the commits in hand, so quietly dropping the ones that failed would
  // let a real bulk-upload repository read as `usable`, or the reverse. Any
  // failure mid-fetch fails the whole result instead.
  //
  // A truncated window is a different thing and is not a failure: those
  // commits were never asked for. It is reported rather than hidden, because
  // the same classification over the newest 40 commits is a statement about
  // recent work and not about the repository. A project that began with one
  // bulk commit and then developed normally is `bulk_upload` over its whole
  // history and `usable` over this window, and both are true of what they
  // describe.
  if (unauthorized) return { ok: false, reason: "unauthorized" };
  if (rateLimited) return { ok: false, reason: "rate_limited" };
  if (failed) return { ok: false, reason: "fetch_failed" };

  return {
    ok: true,
    commits: commits.filter((commit): commit is CommitRecord => commit !== null),
    truncated,
  };
}
