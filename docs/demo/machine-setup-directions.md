# Directions for the agent that sets up the demo machine

Hand this to a computer-use agent on Sam's Mac before the meeting. Everything
here has been run once already; the times are measured, not estimated.

Do not improvise. If a step does not produce what it says, stop and report the
step number and what you saw instead.

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

Confirm the demo clone is clean and on the right commit before touching
anything:

    cd /Users/samgu/BWSI/2026/CogPortal/.cache/demo/cogportal-demo-week1
    git status --porcelain
    git log --oneline -1

Expect empty output, then `7125804 Merge pull request #7 from SP02028/topo-rerank`.
If the tree is dirty, stop and report what changed. Do not discard anything.

## 1. Terminal

Open Sam's terminal application. Make one window with two tabs.

**Tab 1, the demo tab.** Font large enough to read from a projector, at least
18 point. Then:

    cd /Users/samgu/BWSI/2026/CogPortal/.cache/demo/cogportal-demo-week1
    source /Users/samgu/BWSI/2026/CogPortal/.cache/demo/student-venv-final-proof/bin/activate
    clear

Leave it there, with nothing typed. The first command he runs must be visible
from a clean screen.

Warm the caches first, in tab 2, not tab 1:

    cogworks check --benchmark audio-identification

The first run in a fresh shell takes about 18 seconds; the second takes about
2. Run it once in tab 2 so the one he runs live is the fast one. Then `clear`
tab 2 as well.

**Tab 2, the spare.** Same directory, same virtualenv, for anything that goes
wrong. Keep it behind tab 1.

Then, still in tab 2, point the tool at the site:

    cogworks link --portal https://cogportal-dev.sillion.app

It prints a URL and a code and opens a browser page headed "Approve device".
Stop there and tell Sam to press Approve himself; it needs his signed-in
session. Once he has, `cogworks status` prints
`Portal   https://cogportal-dev.sillion.app`. Without this, `cogworks sync`
in the demo posts to a local portal that is not running.

## 2. Editor

Open the demo clone in Sam's usual editor:

    code /Users/samgu/BWSI/2026/CogPortal/.cache/demo/cogportal-demo-week1

If `code` is not on the PATH, open the editor from Applications and open that
folder. Then open exactly one file and leave it on screen:

    create_fingerprints.py

That file holds the one-line change he may demonstrate: the `fanout` default on
`peaks_to_fingerprints`, currently 15. Changing it to 5 raises the score from
0.5375 to 0.5500. Do not make the change. He makes it live if he chooses to.

Close every other editor tab, including anything from the CogPortal repository
itself. A file from the platform's own source on screen during a demo about
student code is confusing.

## 3. Browser

Open Chrome with exactly four tabs, in this order, and leave tab 1 focused:

1. `https://cogportal-dev.sillion.app/dashboard`
2. `https://cogportal-dev.sillion.app/team`
3. `https://cogportal-dev.sillion.app/leaderboard`
4. `https://github.com/SamGu-NRX/cogportal-demo-week1`

Sam must already be signed in on the first three. If any of them shows the
sign-in page, stop and tell him to sign in with GitHub; do not attempt to sign
in for him.

Close every other window and tab. Hide the bookmarks bar. Turn off any
extension that draws over the page, since one of them has been highlighting
text in red on the team page and it reads as an error.

## 4. The two things that must be true before he starts

These are ordering traps, not preferences. Check both.

**The connected repository.** On the team page, the repository must be
`SamGu-NRX/cogportal-demo-week1`. If it is anything else, use Change repository
on that page and pick it. That fork carries the original student team's
history, eight contributors across the five stages of the assignment, which is
what makes the team page worth showing. Sam's own CogPortal repository has one
contributor and the page will say so.

**An audio run must be the most recent run.** The team page reads its stage
names from the team's latest run, not from the repository. With a vision run
last, it looks for vision stages in an audio repository and finds nothing.

This was done on 2026-09-04: run 4131 on Song Identification succeeded on the
hosted runner at 0.5375 in 133 seconds. Open the dashboard and confirm it is
the top row of the run log. Only if it is missing or failed, select the Audio
track, click Run practice benchmark, and wait; expect about two and a half
minutes. If that fails, tell Sam immediately.

**The team page must show people on the stages.** Open the Team page and read
"Where the work went". It must list the five stages with the eight
contributors on them. If it instead says the commit history could not be read
from GitHub, tell Sam to sign out and sign in with GitHub again, then reload
the page. Do not sign him in or out yourself.

## 5. Deck

Open the deck full screen on the display he is presenting from, on the title
slide, and leave the browser and terminal on the other display or behind it.
Check that advancing works before he needs it.

## 6. Report back

Tell him, in this order:

1. Whether the demo clone was clean and on `7125804`.
2. The wall-clock time of the warm-up `check`.
3. Which repository the team page is connected to.
4. Whether run 4131 is the top row of the run log with score 0.5375, or what
   the new run did.
5. Whether "Where the work went" shows people on the stages.
6. Whether `cogworks status` names the site as the portal.
7. Anything you could not do.

## Do not

- Do not commit, push, or discard anything in any repository.
- Do not edit `create_fingerprints.py` or any file in the demo clone.
- Do not touch `apps/portal/.dev.vars` or any file with a credential in it.
- Do not sign in to anything on Sam's behalf.
