# Review bots on this repository

Four automated reviewers are installed. They disagree about what a passing check
means, and two of them report "I did nothing" as a green check, which is how most
open pull requests ended up with unreviewed heads. This is what each one does and
how the review queue decides who gets asked again.

## Who is installed

**CodeRabbit** is configured by `.coderabbit.yaml` at the repository root. CodeRabbit
reads that file from the branch under review, not from main, so a pull request only
picks up the current settings once its branch contains main at `8a1e4f4` or later.
That file turns on auto review for every base branch (`base_branches: [".*"]`),
because the default reviews only pull requests targeting the default branch and
nearly every pull request here is stacked on another branch. It also sets
`drafts: false` and raises `auto_pause_after_reviewed_commits` to 50, since the
default of 10 paused the review of pull request #1 partway through.

The account is on the free open-source tier, which allows a small number of reviews
per hour. Over that allowance CodeRabbit posts a comment saying "Review limit
reached, next included review available in N minutes" and then stops. It does not
come back on its own. Someone has to comment `@coderabbitai review`.

**Greptile** is configured by `greptile.json`. `triggerOnUpdates` makes it re-review
every push and `statusCheck` makes it publish a check run named "Greptile Review".
The review queue does not touch Greptile and should not: it re-triggers itself, and
its usage budget is separate from CodeRabbit's.

**Macroscope** has no file in this repository. It posts a check run named
"Macroscope - Correctness Check" whose conclusion is `skipped` with the title
"Credit balance exhausted." when the workspace budget is spent. The budget is a
slider in the Macroscope workspace settings, so raising it is an account change and
nothing in this repository affects it.

**Codemetrics** is installed on the repository but has not been added to the
Codemetrics team, so it comments "Review skipped" on every pull request and never
reviews. Either add the repository in the Codemetrics dashboard or uninstall the
app; the comment on every pull request is noise either way.

## Draft is the "not ready" signal

A pull request the author is still reworking stays a GitHub draft. CodeRabbit already
skips drafts (`drafts: false`), the queue skips drafts, and no label is involved.
Marking a pull request ready for review is what puts it in the queue.

## How CodeRabbit reports, and what the queue reads

CodeRabbit publishes through the legacy commit status API, under the context
`CodeRabbit`. It does not publish a check run. `GET /repos/{owner}/{repo}/commits/
{sha}/check-runs` returns nothing for it on any commit here, and its check *suite*
stays at `queued` forever, so anything written against the Checks API sees a
CodeRabbit that never ran. The status is at
`GET /repos/{owner}/{repo}/commits/{sha}/status`, in the `statuses` entry whose
`context` is `CodeRabbit`.

The trap is that `state` is `success` for a finished review and for a refused one
alike. Only `description` separates them. These are the values seen on this
repository:

| `state`   | `description`                                            | Meaning                    |
| --------- | -------------------------------------------------------- | -------------------------- |
| `pending` | `Review queued`                                           | accepted, not started      |
| `pending` | `Review in progress`                                      | running                    |
| `success` | `Review completed`                                        | reviewed, nothing to do    |
| `success` | `Review rate limited`                                     | refused, head is unreviewed |
| `success` | `Review skipped: reviews are disabled for this base branch` | refused, head is unreviewed |

An explicit `@coderabbitai review` comment overrides the base-branch refusal, which
matters because that refusal covers most open pull requests and their branches
predate `.coderabbit.yaml`. Pull request #20 is the evidence: its head carried the
base-branch skip at 07:45:36, a bare `@coderabbitai review` comment landed at
08:17:55, and the same head moved to `Review in progress` at 08:18:04.

## What the queue does

`.github/workflows/review-queue.yml` runs `scripts/review-queue.mjs` at 13 minutes
past every hour, and on manual dispatch with a `dry_run` input and an `only_pr`
input. The script asks for at most three reviews per run, oldest head commit first,
and prints one line per open pull request saying what it decided and why. It asks
for a review when all of these hold:

- the pull request is open and not a draft;
- it does not conflict with its base branch, since a conflicted diff is not worth a
  review;
- its head commit's CodeRabbit status is not `Review completed` and is not a live
  `pending` one;
- no `@coderabbitai review` comment exists that is newer than the head commit.

The last rule has one exception. A request that CodeRabbit answered with `Review
rate limited` was refused rather than served, so it left the head unreviewed and the
queue may ask again on a later run. Without that exception a pull request whose first
request happened to land during a rate-limit window would never be reviewed, which is
the problem the queue exists to fix. Retries stop after three requests for the same
head, and the run logs that the pull request needs a human.

The queue never posts `@coderabbitai full review`. The full-review command re-reads
the entire diff instead of the incremental change and costs more of the hourly
allowance for no extra coverage on a head that has never been reviewed at all.

## Running it by hand

```
gh workflow run review-queue.yml -f dry_run=true
gh workflow run review-queue.yml -f dry_run=false -f only_pr=4
```

Locally, `DRY_RUN=1 node scripts/review-queue.mjs` decides and logs without
commenting, using whatever account `gh auth status` reports.

## The token

The workflow uses `secrets.REVIEW_QUEUE_TOKEN` when it is set and falls back to the
built-in `GITHUB_TOKEN`. The fallback posts as `github-actions[bot]`. If CodeRabbit
stops answering commands from that identity, create a fine-grained personal access
token on Sam's own account, scoped to this repository, with **pull requests: read and
write** and **contents: read**, and add it as the repository secret
`REVIEW_QUEUE_TOKEN`. It has to be a user token rather than an app or bot token,
because the identity is the point.
