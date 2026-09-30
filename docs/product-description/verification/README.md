# Hand verification

The feature documents were written from the code and the tests. This directory is the protocol for checking them against the running platform, one observable claim at a time.

## What is here

| File | Covers |
| --- | --- |
| [portal.md](portal.md) | `portal/*` |
| [terminal.md](terminal.md) | `terminal/*` |
| [discord.md](discord.md) | `discord/*` |
| [sandbox.md](sandbox.md) | `sandbox/*`, `cross-cutting/*`, and the `foundations/*` claims that are observable |

Each file has one table per document. Each row is an item with a stable ID (`STATUS-04`, `RUNPAGE-12`), a priority, what it needs, the claim with a link to the document section, the setup, numbered steps, the expected result, and a Result column for the tester. Items that cannot be checked by hand are listed under each document as "Not checkable by hand".

Priorities: **P1** is an established fact, a claim many documents depend on, or a suspected bug. **P2** is an ordinary claim. **P3** is a number, a colour, or a timing.

## How to run a pass

1. **Bring up the surfaces.**
   - The portal: `pnpm dev` in the repository root, then the URL it prints. Sign in with a throwaway GitHub account, join a cohort with a test join code, and connect a repository you can push to. A fresh account is worth the trouble: half the claims in `portal/` are about first-arrival state, and an account that has already joined a team cannot see them again.
   - The terminal: `.venv-test/bin/python -m cogbench` from inside a checkout of a test team repository, or install the CLI into that virtualenv and use `cogworks` directly. Point it at the dev portal with `--portal http://localhost:PORT`, which is allowed precisely because the host is loopback.
   - Discord: the course guild, with the bot deployed against the same portal. There is no way to exercise `/cog` without a guild; every item that needs one is marked `discord` in its Needs column.
   - The sandbox: a hosted practice run started from the dev portal. Most sandbox claims are only observable through the run page, which is why they are checklisted here rather than under `portal/`.
2. **Confirm the commit.** Every document says `Verified against Cog*Portal commit f74e087`. Run `git rev-parse --short HEAD`. If it differs, the documents describe a different build and some failures will be drift rather than defects. Four documents also cite uncommitted work; see the next section.
3. **Keep the documents open beside the product.** Read the linked section before each item. The item is a summary; the section is the claim.
4. **Work through P1 first across all four files, then P2, then P3.**
5. **Record `pass`, `fail`, or `blocked`** in the Result column, with a note for anything other than a clean pass. A fail is something the document says that the product does not do. A blocked item could not be run: no guild, no second account, a prior failure in the way.
6. **File every fail in [`bug-triage.md`](../bug-triage.md).** If the entry exists, add a Status line quoting the item ID. If not, add an entry with the item ID under "Raised by". A fail is not automatically a product defect; sometimes the document is wrong and the fix is to the document. The Status line says which.
7. **Promote a document to `verified`** in the [coverage table](../README.md#coverage) only when every P1 and P2 item for it has passed or been filed.

## Re-read these four before testing them

Four areas were being edited while the documents were drafted, and each affected document carries an "In flight" note naming the exact files. Read the source again before running their items; a failure there is more likely to be drift than a defect.

| Document | Files to re-read |
| --- | --- |
| [`portal/the-team-page.md`](../portal/the-team-page.md) | `apps/portal/src/routes/TeamPage.tsx`, `apps/portal/src/components/ProcessPanel.tsx`, `MemberAvatar.tsx`, `apps/portal/worker/services/process-signals.ts`, `apps/portal/worker/routes/team.ts`, `apps/portal/worker/github/commits.ts` |
| [`terminal/sync.md`](../terminal/sync.md) | `python/cogbench/src/cogbench/cli.py`, `client.py`, `apps/portal/worker/routes/local-reports.ts`, `packages/contracts/src/schema.ts` |
| [`sandbox/prepare.md`](../sandbox/prepare.md) | `apps/runner-modal/src/cogworks_runner/modal_app.py`, `apps/runner-modal/tests/test_prepare_rungs.py`, `test_archive_safety.py` |
| [`sandbox/scoring-and-refusals.md`](../sandbox/scoring-and-refusals.md) | `benchmarks/week3/language_search_benchmark/plugins.py`, `roles.py` |

## What the tester needs, by value in the Needs column

- **`fresh account`**: a GitHub account that has never signed in to this portal. Required for every first-arrival claim. Reusing an account silently skips the gate redirects.
- **`second account`**: a second GitHub account on the same cohort, in a second browser profile. A second tab is not a second account, and a second tab is not a second session either.
- **`creator`** and **`member`**: the team's creator, and a member who is not. Most team-page controls only exist for the first.
- **`owner`**, **`staff`**, **`TA`**: an account listed in `PLATFORM_OWNER_LOGINS`, one added to the staff roster, and one assigned to a team. These are three different views of the admin page and each has to be checked separately.
- **`device`**: a machine that has run `cogworks link` against this portal. A device is not a session; signing out of the browser does not unlink it.
- **`discord`**: the course guild with the bot present, plus a text channel the team can bind. The activity additionally needs a voice channel and a Discord client that supports embedded apps.
- **`offline`**: the network genuinely unavailable, not just a devtools toggle. The toggle does not fail an in-flight WebSocket the way pulling the cable does, and several live-update claims turn on exactly that difference.
- **`piped`**: the CLI's stdout or stderr redirected to a file. `cogworks check`'s progress spinner renders only when stderr is a terminal, so a piped run and a terminal run are two different observations of the same command.
- **`week 3`**: a repository whose Week 3 image side does not bind. Several of the most important refusal claims cannot be seen any other way.
- **`none`**: nothing beyond a signed-in student and the default setup.

## Running the terminal items as a script

Most `terminal/` items are commands with an expected output and an exit code, and can be run as a script. Do that first; it is fast and it settles what happens.

It does not settle everything, and the checklist marks the difference. These items must be watched by hand:

- Anything about the progress spinner, the pairing counter, or the "left at most" estimate. They render only to a terminal and are erased when the phase ends, so a captured log shows nothing.
- Anything about how long a silence lasts. The retry window in `cogworks status` and the search in `cogworks check` are both claims about elapsed time with nothing on screen.
- The browser half of `cogworks link`. The device approval, the 900 ms redirect, and what happens when the student leaves before it fires.

## Results so far

The drafting pass ran nothing, and **all 244 Result columns still read
`not run`**. No row has moved. What was stale here was the reason given: the
old wording implied no evidence existed anywhere, and that is no longer true.

Dated evidence now exists from three separate passes, each against a **named
earlier revision**, not against the current candidate:

- a browser/baseline pass at `c2af396`,
- a restoration pass at `37b1972`,
- role, lifecycle and device passes at `49f6a98`, plus a frozen process
  diagnosis of the same source.

An evidence handoff maps that evidence to these tables ID by ID and states the
limit on each one. It currently lives outside this repository, in the
verification worktree that produced it, which means this instruction is only
followable on the machine that has it — copying it in is the obvious next
step and has not been done. What it says, and what matters here: several IDs
have a partial observation that does **not** close the item, and a static read
of a settled run is not evidence of a live transition.

Two rules follow, and they are the reason this section is not a pass list:

1. Evidence against an earlier revision is evidence about that revision. It
   does not close a row for the current candidate.
2. A partial observation stays `not run` until the whole claim was exercised.
   Attach the observation and its limit in the note instead.

That is deliberate rather than incomplete. The source was being edited by other people throughout the drafting pass, so a browser observation taken during it would have described a build that no longer exists by the time anyone reads this. A separate pass runs the checklists after today's changes land.

Sentences in the documents that were read from code and not observed are marked **unverified** in place, and the things the code could not settle at all are in each document's "Open questions and verification" section. No document is marked `verified` in the coverage table, and none should be until a pass fills these tables in.
