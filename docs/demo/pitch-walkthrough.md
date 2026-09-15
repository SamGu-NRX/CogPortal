# Pitch walkthrough

Cue sheet for the demo after the deck. The site is production,
`https://cogportal.sillion.app`. Paths, machine state and the checks to run
first are in [machine setup](machine-setup-directions.md).

The core takes roughly ten minutes, which is an estimate rather than a
rehearsed figure. The expansions after it stand alone, so take them in any
order or not at all.

## 1. Setup

Open `https://cogportal.sillion.app/setup`.

This account is already set up and the page reads 5 of 5 verified. Say so, and
describe the path rather than performing it.

Say: a student signs in with their own GitHub account, enters the cohort code,
picks the repository their team already works in, and copies the install
commands off this page. The boxes tick when a command reports back from their
machine, so the page is evidence rather than a checklist they fill in.

Say: the team is the repository. Anyone with push access who signs in is a
member, so there is no roster for a TA to maintain.

## 2. Commit and push

In the terminal, in the student checkout.

```sh
git status --short --branch
```

Add one line to `README.md` under the existing heading, naming a command a
teammate would run. The wording is yours.

```sh
git add -- README.md
git diff --cached
git commit -m "docs: explain the benchmark commands"
git push origin codex/demo-rehearsal-d9405278
```

Say: the score belongs to a commit. The hosted runner reads the branch out of
GitHub, so it only scores work that was pushed, and a leaderboard row is a
claim about code somebody else can go read.

Keep the edit in `README.md`. The point here is provenance, not a change to the
code being scored.

## 3. Start the hosted run

Dashboard, on the Song Identification track.

Set **Branch** to `codex/demo-rehearsal-d9405278`. It opens on `main` and does
not follow the push you just made.

Click **Run practice benchmark**. Read the line on the run panel out loud:
`practice · codex/demo-rehearsal-d9405278 · <short sha>`.

Two rehearsed runs took 2m01s and 2m18s. Say "about two minutes".

## 4. While it runs

Back in the terminal, still in the student checkout.

```sh
cogworks run --benchmark audio-identification
```

It scores here and ends with `saved:` and an absolute path. Pass that path to
`sync`:

```sh
cogworks sync <the path it just printed>
```

Naming the path ties what you upload to the commit you just pushed. With no
path, `sync` takes the newest report in this checkout, which is usually the
same file and is one timestamp away from not being.

Reload the dashboard. A synced report does not show up in a tab that is already
open.

The local result appears under `SELF-REPORTED · NOT PROMOTABLE`.

Say: the site is showing a number it did not watch being produced, and it will
not let that number be published.

Discord is running the same story in one message, walking the phases and
settling on the score. Show it if it is on screen.

## 5. The two results

Read the actual numbers off both and say what you see.

They should agree, because a `README` edit does not touch the code being
scored. In the 2026-09-15 rehearsal both came out at 0.5375, with ten of the
eleven displayed metrics matching and an unscored timing differing. If today's
two disagree, that is worth saying plainly and worth knowing.

Say: the hosted runner is Python 3.8 and this machine is 3.11, so agreement
shows the submission is stable across those two, not that the environments are
identical.

## 6. The run page

Open the run. It leads with the finding, then the sweep, then the metrics.

The rehearsed run carried nine diagnostics naming where the points went. Read
what today's run actually shows.

Say: a number near chance with no reason is what this exists to avoid. The
benchmark writes the sentence and the number sits under it.

## Optional expansions

- **Leaderboard.** Song Identification, published results only. The current
  boards report that nothing is published yet, which is the right answer.
- **Team.** The process panel lists the capstone's stages with the people who
  committed to each, and the date spans. Two things to say while it is up: a
  teammate who committed under two identities appears twice, and the panel says
  when it last read the history, which can be half an hour ago. It records
  where work went, not which tasks are done.
- **Other tracks.** Language and both Vision tracks carry their own setup state
  and their own untouched quota, which shows the tracks are separate. None has
  a rehearsed run.
- **The refusal.** A repository the tool cannot read, where it names each
  candidate and why it refused. That case needs a student repository that is
  not on this machine, so describe it rather than running it.

The embedded Discord Activity is not part of this. It still rejects app
sign-in; account linking and the bot are the parts that work.

## If asked

- **Is the scoring real?** Yes, on both surfaces, and it is the same code. In
  rehearsal this repository scored 0.5375 in the terminal and 0.5375 on the
  hosted runner from the same commit.
- **What about cheating?** The official set is hidden, it never enters the
  sandbox that runs student code, and every team gets three official attempts.
  This walkthrough spends none of them.
- **What does it take to adopt?** A team signs in with GitHub, joins the cohort,
  and connects their repository. Each student activates the course environment
  for the week, installs the tool and the benchmark with the two commands on
  the Setup page, and runs `cogworks check` and `cogworks run`.
