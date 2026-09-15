# Pitch walkthrough

What Sam shows and says after the deck, in order. The site is production,
`https://cogportal.sillion.app`, and it is already deployed, so there is
nothing to redeploy before the meeting.

Everything that has to be true first is in
[machine setup](machine-setup-directions.md), which is the one copy of those
directions. This file used to repeat them and the two drifted apart.

Joel's time is not fixed. The core below should take roughly ten minutes,
which is an estimate rather than a rehearsed figure, and it answers the only
question a technical person is holding, which is whether it actually runs.
The expansions after it are each a minute or two and stand alone, so take them
in any order or not at all.

## The core

### 1. Where the work already is

Open `https://cogportal.sillion.app/setup`.

Sam's account is already through onboarding, and the page shows 5 of 5
verified. Say that out loud. It is a rehearsed account, and presenting it as a
fresh signup would be a lie the next click exposes.

Describe the path instead, since the page still shows every step of it: a
student signs in with their own GitHub account, enters the cohort code, picks
the repository their team already works in, and copies the install commands off
this page. The boxes tick when a command reports back from their machine, so
the page is evidence rather than a checklist they fill in themselves.

Say: the team is the repository. Anyone with push access who signs in is a
member, so there is no roster for a TA to maintain.

### 2. The commit

Switch to the terminal, in the student checkout.

```sh
git status --short --branch
```

Then make the edit. Keep it in `README.md`, the way the rehearsed commit did:
one line under the existing heading, naming a command a teammate would run.
What the line says does not matter, and it is his to write on the day. Keeping
it out of the Python is what makes the next two minutes a claim about
provenance rather than an unrehearsed change to the thing being scored.

```sh
git add -- README.md
git diff --cached
git commit -m "docs: explain the benchmark commands"
git push origin codex/demo-rehearsal-d9405278
```

Say: the score belongs to a commit. The hosted runner reads a branch out of
GitHub, so it can only ever score work that was pushed, and a local result from
a worktree with uncommitted changes is never offered hosted verification. A
leaderboard row is a claim about code somebody else can go read.

Be straight about what this edit is. It is a documentation change, and it is
there to show where a result comes from, not to move the number. Do not offer
it as a tuning change, and do not predict a different score from it.

### 3. The hosted run

Back to `https://cogportal.sillion.app/dashboard`, on the Song Identification
track.

**Set the Branch menu to `codex/demo-rehearsal-d9405278` before starting.** It
opens on the repository's default branch, `main`, and it does not follow the
push that just happened. Starting the run without changing it scores `main`,
and the commit made thirty seconds ago never appears.

Then click **Run practice benchmark**. The panel replaces itself with the run,
and its subtitle names the branch and the short commit. Read that line out:
it is the whole provenance claim in one line of monospace.

Two rehearsed runs of this repository finished in 2m01s and 2m18s. Say "about
two minutes" rather than a number he then has to beat.

### 4. While it runs, the same code on his own machine

The wait is about two minutes, and the CLI fills it with something better than
a progress rail. Back in the terminal, which is still in the student checkout:

```sh
cogworks run --benchmark audio-identification
```

It scores on this machine and prints where it saved the report. The rehearsal
report for the previous commit records twelve seconds between start and finish,
eleven metrics, and nine diagnostics. That speed is the on-ramp argument from
the deck, running.

The last line it prints reads `saved:` followed by an absolute path. Copy that
path and pass it to `cogworks sync`. Do not run `sync` with no path: it falls
back to the most recent report on the machine, which on this machine may belong
to a different repository, and on stage that would quietly put someone else's
result on the board.

Then reload the dashboard. A synced report does not appear in a tab that is
already open, because the local-report query does not poll and the app turns
off refetching when a window regains focus (`apps/portal/src/App.tsx:27`). The
hosted run's own polling refreshes a different query, so the page can end up
showing the hosted result and not the local one.

The local result arrives under `SELF-REPORTED · NOT PROMOTABLE`. Say what the
label is doing: the site shows a number it did not watch being produced, and it
will not let that number be published. Had the worktree been dirty, the page
would not offer hosted verification at all, and it would say why: "Hosted
verification needs a commit."

Meanwhile the bot is posting the hosted run into the team's Discord channel and
editing that one message as the phases pass. In rehearsal it ran from bench
preparation through contract checking, 282 evaluated cases, and scoring, then
settled at 0.5375 with the short commit and the wall clock. If Discord is not
on screen, `cogworks status` answers the same provenance question from the
terminal side: which account, team, repository, and portal this machine is
attached to.

### 5. The two results

When the hosted run lands, put them next to each other. Both should read
0.5375.

Expect that, and say why. The edit was a documentation change, so the code the
benchmark scores is unchanged, and the number has no reason to move. If it had
moved, something other than the commit changed, and that is worth knowing.

Ten of the eleven metrics matched at the precision the site displays when this
was rehearsed, and the one that differed was an unscored timing. Worth saying,
and worth not overstating: the hosted runner is Python 3.8 and the local
environment is 3.11, so the agreement shows this submission is stable across
two environments, not that the environments are identical.

### 6. What the run says

Open the run. It leads with the finding sentence, not the score, and the
diagnostics under it name which half of the pipeline lost the points. All nine
diagnostics the benchmark wrote reach this page.

Say: a number near chance with no reason is the mystery box this course exists
to avoid. The point of the instrument is the sentence, and the number sits
below it.

## Optional expansions

- **Leaderboard.** Song Identification, published results only. Current
  component boards honestly report that nothing is published yet, which is the
  right answer and not an empty state to apologize for.
- **Team.** The process panel lists the stages of the capstone with the people
  who committed to each, and the date spans. It reads them from this team's
  commits, so the stages it shows are whatever the history supports. Two
  warnings before showing it. A teammate who committed under two identities
  appears twice, so read what is on screen rather than promising a headcount.
  And the panel says when it last read the history, which can be half an hour
  ago, so do not present it as live. It is a record of where work went, not a
  count of tasks completed.
- **Other tracks.** Language and both Vision tracks each show their own setup
  state and their own untouched quota, which is the clearest way to show the
  tracks are genuinely separate. None of them has a rehearsed run, so do not
  start one.
- **The refusal.** The strongest slide in the old version of this demo was a
  repository the tool could not read, where it names each candidate and why it
  refused. That case needs a student repository that is not on this machine any
  more, so describe it rather than running it, or leave it for a follow-up.

The embedded Discord Activity is not part of this. It still rejects app
sign-in, and account linking and the bot are the parts that work.

## What to say if asked

- **Is the scoring real?** Yes, on both surfaces, and it is the same code. This
  repository scored 0.5375 in the terminal and 0.5375 on the hosted runner,
  from the same commit.
- **What about cheating?** The official set is hidden, it never enters the
  sandbox that runs student code, and every team gets three official attempts.
  This walkthrough spends none of them.
- **What does it cost the course?** No lecture time. A team connects a
  repository and copies the commands off one page.
