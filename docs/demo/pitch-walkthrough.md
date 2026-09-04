# Pitch walkthrough

Fifteen minutes, three acts. Everything here runs offline against real 2026
student repositories. Nothing needs Modal, R2, or a deploy.

Setup, once, before anyone is watching:

```sh
cd ~/BWSI/2026/CogPortal
pnpm --filter @cogworks/portal dev          # http://localhost:5173
```

## Act 1: the claim, in a terminal

A repository nobody prepared, scored by running it.

```sh
cd .cache/student-repos/carti4ce__week1_capstone
cogworks check --benchmark audio-identification
```

Under two seconds. It reads seven of their files, skips fifteen scripts that
want a microphone this machine does not have, and prints the five functions it
will call:

```
Wired up:
  spectrogram    spectrogram.make_spectrogram
  peaks          fingerprint.find_peaks
  fingerprints   fingerprint.make_fgp
  store          database.add
  query          match.query_details

Your code is wired up and ready to score.
```

The point to say out loud: nobody wrote an adapter for this team. Their
functions are called `add` and `query_details`. The names ordered the
candidates; running them decided.

Then score it:

```sh
cogworks run --benchmark audio-identification
```

Forty seconds, ending in `identification_score` and six diagnostics that name
which half of their pipeline lost the points.

## Act 2: what it says when it cannot

```sh
cd ../CogWorks-2026-Team-Asterisk__Week1-Capstone-Shazam
cogworks check --benchmark audio-identification
```

This team's capstone does not run. The report says so the way a compiler
would:

```
Could not read:
  Code: RuntimeError: microphone.record_audio is not available here
  master: is empty
  will_is_not_locked_bro: FileNotFoundError: 'song_list'

Nothing in your repository took that for the database step, which is what
newton's_code.create_fingerprints returned.
```

It still names the two steps it did bind. The line worth saying: a refusal has
to be worth reading, because half of a real cohort will see one first.

## Act 3: the platform

Open http://localhost:5173, sign in with GitHub, and walk:

1. **Dashboard.** The run list, the practice and official counters.
2. **A succeeded run.** The finding sentence leads, then the metric grid, then
   the diagnostics that say which component lost the points.
3. **Team.** The process panel: which capstone stage each person touched and
   when, the first run that scored end to end, and any commit that changed a
   contract file since. No per-person totals anywhere, on purpose.
4. **Leaderboard.**

Two things this local database cannot show, so do not promise them here. The
seeded runs carry no wiring trace and no refusal card, because they were
written by the fixture provider rather than by a sandbox that ran discovery;
Act 2 is where the refusal lives. And the team is connected to the fixture
repository, which is not on GitHub, so the process panel says it could not
read a commit history rather than drawing the stage rows. Connecting a real
repository with the GitHub App installed fills it.

Runs on this machine are scripted (`EXECUTION_PROVIDER=fixture`); the hosted
runner is deployed but the demo does not need it. Say that if asked. The
scoring in Act 1 is real and is the same code the sandbox runs.

## If someone asks what is next

- R2 is not yet enabled on the Cloudflare account, which is the last step
  before a team's trained weights can travel from their laptop to a hosted
  run without being committed.
- `EXECUTION_PROVIDER` is still `fixture` in both deployed workers.
- 46 defects are written down in `docs/product-description/bug-triage.md`,
  ranked by what a first-time user hits first.
