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

Priorities: **P1** is an established fact, a claim many documents depend on, or a suspected bug. **P2** is an ordinary claim. **P3** is a number, a color, or a timing.

## How to run a pass

1. **Bring up the surfaces.**
   - The portal: `pnpm dev` in the repository root, then the URL it prints. Sign in with a throwaway GitHub account, join a cohort with a test join code, and connect a repository you can push to. A fresh account is worth the trouble: half the claims in `portal/` are about first-arrival state, and an account that has already joined a team cannot see them again.
   - The terminal: `.venv-test/bin/python -m cogbench` from inside a checkout of a test team repository, or install the CLI into that virtualenv and use `cogworks` directly. Point it at the dev portal with `--portal http://localhost:PORT`, which is allowed precisely because the host is loopback.
   - Discord: the course guild, with the bot deployed against the same portal. There is no way to exercise `/cog` without a guild; every item that needs one is marked `discord` in its Needs column.
   - The sandbox: a hosted practice run started from the dev portal. Most sandbox claims are only observable through the run page, which is why they are checklisted here rather than under `portal/`.
2. **Confirm the build.** Every document says ``Read against Cog*Portal commit `2ff32fa` ``. Run `git rev-parse --short HEAD` on the portal you are testing, and for hosted work record the deployed Worker's commit too. Hosted beta (`4984730`) is a different build: record its results as beta, never as the candidate. Record which CLI is installed as well (see `terminal.md`); the setup page pins one that is older than the tree.
3. **Keep the documents open beside the product.** Read the linked section before each item. The item is a summary; the section is the claim.
4. **Work through P1 first across all four files, then P2, then P3.**
5. **Record `pass`, `fail`, or `blocked`** in the Result column, with a note for anything other than a clean pass. A fail is something the document says that the product does not do. A blocked item could not be run: no guild, no second account, a prior failure in the way.
6. **File every fail in [`bug-triage.md`](../bug-triage.md).** If the entry exists, add a Status line quoting the item ID. If not, add an entry with the item ID under "Raised by". A fail is not automatically a product defect; sometimes the document is wrong and the fix is to the document. The Status line says which.
7. **Promote a document to `verified`** in the [coverage table](../README.md#coverage) only when every P1 and P2 item for it has passed or been filed.

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

The tables were re-read against `2ff32fa` on 2026-10-01 and carry 401 items. A Result moved only where an existing artifact exercised the whole claim on a named build; reading code moved nothing.

| File | Items | pass (candidate) | fail | retired | not run, partial or beta only |
| --- | --- | --- | --- | --- | --- |
| `portal.md` | 166 | 29 | 2 | 2 | 133 |
| `terminal.md` | 86 | 0 | 0 | 1 | 85 |
| `discord.md` | 45 | 0 | 0 | 0 | 45 |
| `sandbox.md` | 104 | 6 | 0 | 1 | 97 |

Nearly every `pass` is a **local fixture** observation: a screenshot or clip of the redesign on seeded data, labeled Simulated. It shows that a screen renders a state, not that the state is reached by real execution. The `fail` rows cite their artifact. Rows marked `on beta only` were exercised by the two hosted Recognition runs on beta (`4984730` lineage) and stay `not run` for the candidate.

No document is `verified`, because each still has P1 or P2 items that need one of the gaps below.

## Evidence gaps

These are the observations that block `verified`, with what each needs. The release owner schedules them after the combined UI acceptance; none needs work in this directory first.

| Gap | What it unblocks | Needs | Command or procedure |
| --- | --- | --- | --- |
| Fresh hosted Language execution | `SCORE-*` withheld and finding rows, `CROSS-14`/`-15`, `BOARD-10`, B-50, B-68 | A Modal-backed portal at the combined build, a Language repository with and one without a trained `(512, D)` projection | Start a hosted practice run of each, then promote and publish the withheld one and open the Language board and the team channel. |
| Hosted Audio and Clustering | Every benchmark kind other than Recognition | Same, with an Audio and a Clustering repository | One hosted practice run each; read the finding line and readings. |
| Recognition on the candidate | B-44 and B-45 on the combined build | A Modal image built from the combined tree after `git submodule sync --recursive && git submodule update --init` | Hosted practice run of `SamGu-NRX/week2_capstone@29f9cf94` on `vision-recognition` v2. Before #53 is ported, expect E-RUNTIME "'NoneType' object is not subscriptable". |
| Current CLI setup, link, run and sync | Every `terminal.md` row, `SETUP-*` CLI rows, B-02, B-16, B-47, B-59 | A fresh course conda env and a test team | Run the setup page's tool line, then `cogworks link --portal <origin>`, `cogworks status`, `cogworks check --benchmark <id> --update-setup`, `cogworks run --benchmark <id>`, `cogworks sync`. Record `direct_url.json` first. |
| Live session after a lost heartbeat | B-13 (repair active in Opus thread `58cdb791`) | A linked device and a bound channel | `cogworks run --benchmark <id> --live`, then close the terminal window mid-run; watch the bubble and the console for an hour. |
| Instructor write operations | `ADMIN-*` mutations, B-53, B-65, B-66 | An owner account, a second staff login, a TA assignment | Add staff, assign a TA, rotate the code, close enrollment, assign a student, remove a member; read each result as owner and as the TA. |
| Discord and the Activity | Every `discord.md` row, B-49, B-54 to B-58, B-64 | The course guild with the bot registered against the combined portal, a bindable channel, two linked members | Link from `/cog`, bind a channel, start a hosted run from the browser, promote from `/cog`, open the Activity. |
| Physical phone | The 390 px claims, which were emulated | An iPhone and an Android phone | Walk sign-in to the Runs page and a failed run page. |
