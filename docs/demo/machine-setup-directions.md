# Directions for the agent that sets up the demo machine

Hand this to a computer-use agent on Sam's Mac before the meeting. This is the
one rehearsal guide; `pitch-walkthrough.md` covers what Sam says and points
here for everything that has to be true first.

Do not improvise. If a step does not produce what it says, stop and report the
step number and what you saw instead.

**Leave Sam's state alone.** He works with many windows, tabs, and editor
buffers open, and you cannot put them back. Open new windows for the demo.
Never close, quit, or sign out of anything you did not open.

Timings below are dated. Each one was measured once, on the date given, and the
CLI and portal have both moved since. Treat them as the last known good number
and re-time the warm-up on the day rather than promising a figure on stage.

## What you are setting up

Three surfaces, in this order on screen: a slide deck, a terminal, and a
browser. Sam talks over the deck, runs commands in the terminal, then shows the
site. Nothing here needs the network except the browser and one device link.

## 0. Before anything

- The repository is `/Users/samgu/BWSI/2026/CogPortal`.
- The demo clone is
  `/Users/samgu/BWSI/2026/CogPortal/.cache/demo/cogportal-demo-week1`.
- The prepared virtualenv is
  `/Users/samgu/BWSI/2026/CogPortal/.cache/demo/student-venv-final-proof`.
- The site is `https://cogportal-dev.sillion.app`.

Confirm the demo clone is on the right commit:

    cd /Users/samgu/BWSI/2026/CogPortal/.cache/demo/cogportal-demo-week1
    git status --porcelain
    git log --oneline -1

Expect two untracked Cursor paths, `.cogbench/` if the cache has been warmed,
and nothing else, then
`7125804 Merge pull request #7 from SP02028/topo-rerank`. Stop and report if a
tracked file is modified or HEAD is different. Do not discard anything.

Then confirm which CLI that virtualenv actually resolves to. It holds an
editable install, so it points at a working tree rather than a fixed copy, and
that tree moves:

    source /Users/samgu/BWSI/2026/CogPortal/.cache/demo/student-venv-final-proof/bin/activate
    python -c "import cogbench; print(cogbench.__file__)"
    git -C /Users/samgu/BWSI/2026/CogPortal log --oneline -1

Report both. If the printed path is inside a repository whose HEAD you cannot
identify, say so rather than rehearsing against an unknown version.

## 0b. Which checkout and which environment

There are two ways to rehearse and they are not interchangeable.

**The demo clone**, above, is what Sam shows on stage: a real student
repository at a fixed commit.

**The rehearsal worktree** is where the CLI itself was exercised end to end on
2026-09-09: a detached worktree of this repository at
`/Users/samgu/Programming Projects/cogportal-demo-rehearsal`, with its tracked
tree clean. It exists so a rehearsal cannot disturb the working tree, which
usually carries parallel work.

The environment used for that rehearsal was a fresh Python 3.11.15 virtualenv
outside the repository, holding only what the setup page asks for plus the
course packages. Device credentials for it live in the operator's own private
configuration, never in this repository and never in the global CLI
configuration. Do not copy them here.

**The two install commands on the setup page are not the whole environment.**
They install `cogworks-benchmark` and the Audio benchmark, and nothing else.
A student's own code imports the course stack, librosa, numba, numpy and the
rest, and those come from the CogWeb conda environment for the week. The CLI
declares that list (`cogbench/environment.py`, `requirement_strings`) and
`cogworks check` reports which of them this machine is missing, so run `check`
before concluding the environment is ready. On 2026-09-09 the fresh environment
also lacked Flask, which one file in the demo repository imports; `check` said
so, skipped that file, and scored anyway.

## 1. Terminal

Open a new terminal window with two tabs.

**Tab 1, the demo tab.** Font large enough to read from a projector, at least
18 point. Then:

    cd /Users/samgu/BWSI/2026/CogPortal/.cache/demo/cogportal-demo-week1
    source /Users/samgu/BWSI/2026/CogPortal/.cache/demo/student-venv-final-proof/bin/activate
    clear

Leave it there, with nothing typed. The first command he runs must be visible
from a clean screen.

Warm the discovery cache in tab 2, not tab 1:

    cogworks check --benchmark audio-identification

On 2026-09-04 the first run in a fresh shell took about 18 seconds and the
second about 2. The answer is cached under `.cogbench/` in the demo clone,
keyed on the contents of the files the search read, so warming it from either
tab helps and any edit to those files clears it. Expect the first command after
a live edit to be slow again. Then `clear` tab 2.

**Tab 2, the spare.** Same directory, same virtualenv, for anything that goes
wrong. Keep it behind tab 1.

Then, still in tab 2, point the tool at the site:

    cogworks link --portal https://cogportal-dev.sillion.app --no-browser

Use `--no-browser`. Without it the CLI opens the operating system's default
browser, which may not be the one holding Sam's signed-in session. Paste the
printed URL into the Helium window from step 3 instead. It shows a page headed
"Approve device" with the code. Stop there and tell Sam to press Approve
himself; it needs his session. Once he has, `cogworks status` prints
`Portal   https://cogportal-dev.sillion.app`. Without this, `cogworks sync` in
the demo posts to a local portal that is not running.

## 2. Editor

Open the demo clone in a **new** Cursor window:

    cursor /Users/samgu/BWSI/2026/CogPortal/.cache/demo/cogportal-demo-week1

`code` is not on this machine. If `cursor` is not on the PATH, open Cursor from
Applications and open that folder in a new window. Do not close anything
already open, in this window or any other.

Open exactly one file in the new window and leave it on screen:

    create_fingerprints.py

That file holds the one-line change he may demonstrate: the `fanout` default on
`peaks_to_fingerprints`, currently 15. Changing it to 5 raises the score from
0.5375 to 0.5500. Do not make the change. He makes it live if he chooses to.

## 3. Browser

Open a **new Helium window** with exactly four tabs, in this order, and leave
tab 1 focused. Helium is the browser Sam uses and the one holding his signed-in
session; Chrome is also installed on this machine and is not the one to use.

1. `https://cogportal-dev.sillion.app/dashboard`
2. `https://cogportal-dev.sillion.app/team`
3. `https://cogportal-dev.sillion.app/leaderboard`
4. `https://github.com/SamGu-NRX/cogportal-demo-week1`

Sam must already be signed in on the first three. If any shows the sign-in
page, stop and tell him; do not attempt to sign in for him.

Leave every other window, tab, and extension exactly as it is. If an extension
draws over the page, that is a problem for this new window only, and worth
reporting rather than fixing in his working profile.

## 4. What must be true before he starts

Two preconditions. The order no longer matters: runs are scoped to the
connected repository, so a run against a different repository is set aside and
the panel says so rather than showing the wrong week.

**The connected repository.** On the team page, the repository must be
`SamGu-NRX/cogportal-demo-week1`. If it is anything else, use Change repository
on that page and pick it. That fork carries the original student team's
history across the five stages of the assignment, which is what makes the team
page worth showing. Sam's own CogPortal repository has one contributor and the
page will say so.

**A succeeded run against that repository.** Set the track to Song
Identification first: the dashboard's run log is scoped to the selected
benchmark, and the default selection is not necessarily audio. The top row
should then read `RUN 5436`, score 0.5375, from 2026-09-09.

If it is missing or failed, click Run practice benchmark on the Audio track and
wait. Two hosted runs of this repository have finished, at 133 seconds on
2026-09-04 and 2 minutes 11 seconds on 2026-09-09. The sandbox ceiling is 900
seconds and a run still reading `queued` is failed automatically after ten
minutes. Tell Sam if it is still queued at ten minutes, or still running past
twelve.

**The team page must show people on the stages.** Open the Team page and read
"Where the work went". It lists five stages, with the people who committed to
each. Report how many names it shows; a teammate who committed under two
identities appears twice, which is not a fault.

If instead it says the history could not be read, read which sentence it is.
One names the sign-in and already carries its own instruction; reload once
first, because the answer is no longer cached, and only then tell Sam to sign
out and back in. The other says the history could not be read just now: wait a
minute and reload, and do not sign him out. Do not sign him in or out yourself
in either case.

## 4b. What has actually been measured, and when

Keep these apart from the timings in this document. These are dated results
against the real portal and the real runner; the timings elsewhere are
warm-up measurements, and the test suites are neither.

- 2026-09-09, hosted: practice run of `SamGu-NRX/cogportal-demo-week1` at
  `7125804` scored 0.5375 in 2 minutes 11 seconds on the Modal runner, through
  the deployed dev portal. Observed from queued to succeeded in the browser.
- 2026-09-09, local: `cogworks run --benchmark audio-identification` in the
  rehearsal environment scored 0.5375 at the same commit and exited zero. The
  report synced and appeared on the dashboard as SELF-REPORTED, NOT PROMOTABLE.
  Hosted practice usage stayed 2/10 and official 0/3.
- 2026-09-09, setup: `check --update-setup` moved the setup page to 5 of 5
  verified.

The two 0.5375 figures agreeing is worth saying out loud on stage, and worth
not overstating: the hosted runner is Python 3.8.20 and the rehearsal
environment was 3.11.15, so equal scores show this submission is stable across
those two environments, not that the environments are identical.

## 5. Deck

Open the deck full screen on the display he is presenting from, on the title
slide, and leave the browser and terminal on the other display or behind it.
Check that advancing works before he needs it.

## 6. Report back

Tell him, in this order:

1. Whether the demo clone is on `7125804`, and anything untracked beyond the
   two Cursor paths.
2. What `cogbench.__file__` printed, and the HEAD of the repository it points
   into.
3. The wall-clock time of the warm-up `check`, both runs.
4. Which repository the team page is connected to.
5. Whether `RUN 5436` is the top row of the Song Identification run log at
   0.5375, or what a new run did.
6. How many names "Where the work went" shows across the five stages.
7. Whether `cogworks status` names the site as the portal.
8. Anything you could not do.

## Do not

- Do not commit, push, or discard anything in any repository.
- Do not edit `create_fingerprints.py` or any file in the demo clone.
- Do not touch `apps/portal/.dev.vars` or any file with a credential in it.
- Do not sign in to anything on Sam's behalf.
- Do not close windows, tabs, or editor buffers you did not open, and do not
  quit an application that was already running.
