# Hand verification

The feature documents were written from the code and the tests. This directory is the protocol for checking them against the running platform, one observable claim at a time.

## What is here

| File | Covers |
| --- | --- |
| [portal.md](portal.md) | `portal/*` |
| [terminal.md](terminal.md) | `terminal/*` |
| [discord.md](discord.md) | `discord/*` |
| [sandbox.md](sandbox.md) | `sandbox/*`, `cross-cutting/*`, and the `foundations/*` claims that are observable |
| [checkpoint-edf4de3.md](checkpoint-edf4de3.md) | The current candidate `edf4de3`: what it changes, the two practice runs and the CLI pass on an owned Modal environment, and what was not shown |
| [checkpoint-17d26d9.md](checkpoint-17d26d9.md) | What was observed on the accepted beta `17d26d9` locally, kept apart from the rows above |

Each file has one table per document. Each row is an item with a stable ID (`STATUS-04`, `RUNPAGE-12`), a priority, what it needs, the claim with a link to the document section, the setup, numbered steps, the expected result, and a Result column for the tester. Items that cannot be checked by hand are listed under each document as "Not checkable by hand".

Priorities: **P1** is an established fact, a claim many documents depend on, or a suspected bug. **P2** is an ordinary claim. **P3** is a number, a color, or a timing.

The tables are a coverage inventory, not a release gate. They list every claim the documents make so that a pass can pick from them and nothing is forgotten. The release owner chooses which journeys and risks to exercise; a useful delivery does not wait for all 401 rows.

## How to run a pass

1. **Bring up the surfaces.**
   - The portal: `pnpm dev` in the repository root, then the URL it prints. Sign in with a throwaway GitHub account, join a cohort with a test join code, and connect a repository you can push to. A fresh account is worth the trouble: half the claims in `portal/` are about first-arrival state, and an account that has already joined a team cannot see them again.
   - The terminal: `.venv-test/bin/python -m cogbench` from inside a checkout of a test team repository, or install the CLI into that virtualenv and use `cogworks` directly. Point it at the dev portal with `--portal http://localhost:PORT`, which is allowed precisely because the host is loopback.
   - Discord: the course guild, with the bot deployed against the same portal. There is no way to exercise `/cog` without a guild; every item that needs one is marked `discord` in its Needs column.
   - The sandbox: a hosted practice run started from the dev portal. Most sandbox claims are only observable through the run page, which is why they are checklisted here rather than under `portal/`.
2. **Confirm the build.** Every document says ``Read against Cog*Portal commit `2ff32fa` ``. Run `git rev-parse --short HEAD` on the portal you are testing, and for hosted work record the deployed Worker version too. Two hosted builds appear in recorded results. *Hosted beta* means `4984730`, the pre-redesign deployment. *Deployed beta* means `ed2b194` (Worker version `0b452503-80b8-44bc-b60d-a04a38cc5175`), which is `2ff32fa` merged with `4984730` and was the deployed build when these results were recorded on 2026-10-01; its setup page pins CLI `b6bbffb`. A later deployment is neither: label every result with the build it actually ran on. Results already recorded against `4984730`, `ed2b194`, `2ff32fa` or `cbd8266` keep their labels. Record which CLI is installed as well (see `terminal.md`).
3. **Keep the documents open beside the product.** Read the linked section before each item. The item is a summary; the section is the claim.
4. **Run the journeys and risks the release owner has prioritized.** Within those, take P1 rows before P2 and P3.
5. **Record `pass`, `fail`, or `blocked`** in the Result column, with a note for anything other than a clean pass. A fail is something the document says that the product does not do. A blocked item could not be run: no guild, no second account, a prior failure in the way.
6. **File every fail in [`bug-triage.md`](../bug-triage.md).** If the entry exists, add a Status line quoting the item ID. If not, add an entry with the item ID under "Raised by". A fail is not automatically a product defect; sometimes the document is wrong and the fix is to the document. The Status line says which.
7. **Promote a document to `verified`** in the [coverage table](../README.md#coverage) only when every P1 and P2 item for it has passed or been filed. `verified` is a documentation status: it says the description has been checked, not that the product may ship.

## What the tester needs, by value in the Needs column

- **`fresh account`**: a GitHub account that has never signed in to this portal. Required for every first-arrival claim. Reusing an account silently skips the gate redirects.
- **`second account`**: a second GitHub account on the same cohort, in a second browser profile. A second tab is not a second account, and a second tab is not a second session either.
- **`creator`** and **`member`**: the team's creator, and a member who is not. Most team-page controls only exist for the first.
- **`owner`**, **`staff`**, **`TA`**: an account listed in `PLATFORM_OWNER_LOGINS`, one added to the staff roster, and one assigned to a team. These are three different views of the admin page and each has to be checked separately.
- **`device`**: a machine that has run `cogworks link` against this portal. A device is not a session; signing out of the browser does not unlink it.
- **`discord`**: the course guild with the bot present, plus a text channel the team can bind. The activity additionally needs a voice channel and a Discord client that supports embedded apps.
- **`offline`**: a controlled network failure for the request under test, such as a blocked route, a proxy that drops the connection, or the browser's offline mode. Use whichever establishes the behavior and record which one. A browser's offline toggle may not close an already-open WebSocket, so a live-update claim needs a method that does. Nobody's own machine needs to be disconnected.
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

Three builds matter, and every Result names one:

- **`2ff32fa`, the source and UI candidate.** What the documents describe. Observed only locally, on fixture data.
- **`ed2b194`, the deployed redesigned beta.** `2ff32fa` merged with hosted beta `4984730` (so it carries #46, #53 and CLI pin `b6bbffb`), live as Worker version `0b452503-80b8-44bc-b60d-a04a38cc5175` with the runner unchanged at Modal v44 from `4984730`. All eight CI lanes pass. Observed in the combined local acceptance (`CogPortal-qa-video-20260930/outputs/beta-qa/ed2b194-acceptance.md`) and one real hosted Language run plus a real CLI pass (`beta-qa/live-language-ed2b194/README.md`).
- **`cbd8266`, a local repair branch on `ed2b194`.** Source fixes for B-13 and B-14, reviewed and tested, website consumer included. Not deployed. Its B-13 recovery path was accepted locally on fixture data (`beta-qa/cbd8266-recovery-acceptance.md`); see B-13 for the limits.

| File | Items | pass, local fixture | pass on deployed `ed2b194` | fail | retired | not run, partial or beta only |
| --- | --- | --- | --- | --- | --- | --- |
| `portal.md` | 166 | 28 | 3 | 2 | 2 | 131 |
| `terminal.md` | 86 | 0 | 1 | 0 | 1 | 84 |
| `discord.md` | 45 | 0 | 0 | 0 | 0 | 45 |
| `sandbox.md` | 104 | 6 | 1 | 0 | 1 | 96 |

A local fixture `pass` shows a screen renders a state on seeded, Simulated data. A deployed `pass` was exercised end to end on `ed2b194`. Rows marked `on beta only` came from the two pre-redesign hosted Recognition runs (`4984730` lineage).

No document is `verified`; each still has P1 or P2 items behind one of the gaps below. That says how much of the description has been checked, not whether the product is ready.

## Evidence gaps

Covered since the last revision, on deployed `ed2b194`: a fresh hosted Language run (`run_d11b5e5e2e`, succeeded, 9 cases, 19 metrics, 15 m 38 s, of which Install was 7 m 37 s with progress shown throughout), and the current CLI's `check --update-setup`, `run` and `sync` with Setup reaching 5/5. The CLI pass reused local source equal to the `b6bbffb` pin and needed course packages added by hand, so it does not prove a fresh setup from the page's lines alone.

Observed locally on `17d26d9` with the fixture provider, and recorded in [checkpoint-17d26d9.md](checkpoint-17d26d9.md) rather than in the rows: publication refused for a synthetic partial Language result (B-50), teamless staff routed to `/admin` (B-48), the staff roster note and empty TA workspace (B-66), the Connections grant copy (B-49), and a real CLI link, approval and revocation. None of it closes a gap below; each gap still needs the build and setup its own row names.

The full hosted path at `f618038` is a separate receipt. A local Worker dispatched straight to the deployed beta runner v48 (deployed from `17d26d9`). Signed callbacks went into local D1, and the run page was reloaded in Chromium. The team connected a real public repository with a GitHub token placed in local D1; GitHub sign-in itself was not part of the run. There were two Language practice runs:

- `run_6867b9fefa` on `bb08255` succeeded at Overall 0.1540, opening on the benchmark's finding (B-68).
- `run_e9206870c0` on a deliberately malformed `4c6d54d` succeeded with notes, leading "What this run shows" with "text component scored 0: embed_text returned an array with 1 dimensions; expected a 2-D (rows, D) matrix."

Every callback was answered `200`, and an unsigned one `401`. This run did not exercise sign-in, Cloudflare Queues, hosted D1, promotion, publication, weights or Discord. Later integrated commits have local evidence only.

What still blocks `verified`, with what each needs. The release owner decides which of these matter for a given delivery.

| Gap | What it unblocks | Needs | Command or procedure |
| --- | --- | --- | --- |
| A withheld Language run | `SCORE-01` to `-04`, `RUNPAGE-02`/`-03`, `BOARD-10`, B-50 | A Language repository with no trained `(512, D)` projection, on `ed2b194` | Hosted practice run, then promote and publish it and open the Language board. |
| Hosted Audio and Clustering | Every benchmark kind other than Recognition and Language | One repository of each, on `ed2b194` | One hosted practice run each; read the finding line and readings. |
| Official promotion and publication | `PROMOTE-*`, `RUNREC-04`, `CROSS-15`, B-51, B-67 | A succeeded practice run and one official attempt to spend | Promote, let it finish, publish, open the board signed out. |
| Fresh setup from the page's lines | `SETUP-*` install rows, `CHECK-01` | A fresh course conda env with nothing preinstalled | Run each Setup line as printed, then `cogworks check --benchmark <id> --update-setup`. |
| Live session after a lost heartbeat, deployed | B-13 once `cbd8266` is deployed; the local fixture path already passed | `cbd8266` deployed, a linked device and a bound channel | `cogworks run --benchmark <id> --live`, close the terminal mid-run, wait out the real two-minute silence, and watch the console and the Discord bubble move to lost contact. |
| Persistent instructor writes | `ADMIN-*` mutations, B-53, B-65, B-66 | An owner, a second staff login, a TA assignment | Add staff, assign a TA, rotate the code, close enrollment, assign and remove a member; read each as owner and as TA. |
| Discord and the Activity | Every `discord.md` row, B-49, B-54 to B-58, B-64 | The course guild with the bot on `ed2b194`, a bindable channel, two linked members | Link from `/cog`, bind a channel, start a hosted run, promote from `/cog`, open the Activity. |
| Physical phone | The 390 px claims, all emulated | An iPhone and an Android phone | Walk sign-in to the Runs page and a failed run page. |
