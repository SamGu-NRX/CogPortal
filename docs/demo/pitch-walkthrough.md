# Pitch walkthrough

What Sam says and shows, in order: deck, terminal, website. The site is
https://cogportal-dev.sillion.app. It is deployed by hand, so redeploy from
this branch before rehearsing, or write down which commit is live.

## Before anyone is watching

Everything that has to be true first, and the order to do it in, is in
[machine-setup-directions.md](machine-setup-directions.md). It is the one
current copy of those directions; this file used to repeat them and the two
drifted apart.

The short version, so you know what the walkthrough assumes: the team page is
connected to `SamGu-NRX/cogportal-demo-week1`, that repository has a succeeded
Song Identification run, the discovery cache in the demo clone is warm, and
`cogworks status` names the dev site as the portal.

## Act 1: the claim, in a terminal

```sh
cogworks check --benchmark audio-identification
```

A couple of seconds once the cache is warm, and it prints the five functions
it will call:

```
Wired up:
  spectrogram    create_spectogram.create_spectrogram
  peaks          find_peaks.find_peaks
  fingerprints   create_fingerprints.peaks_to_fingerprints
  store          database.AudioDatabase().store_fingerprints
  query          database.AudioDatabase().query
```

Say: nobody wrote an adapter for this team. Two of those are methods on an
object their code builds. The names ordered the candidates; running them
decided.

```sh
cogworks run --benchmark audio-identification
```

Under a minute to a real score with diagnostics that name which
half of the pipeline lost the points.

## Act 2: what it says when it cannot

```sh
cd ../../student-repos/CogWorks-2026-Team-Asterisk__Week1-Capstone-Shazam
cogworks check --benchmark audio-identification
```

```
Could not read:
  Code: RuntimeError: microphone.record_audio is not available here
  master: is empty
  will_is_not_locked_bro: FileNotFoundError: 'song_list'

Nothing in your repository took that for the database step, which is what
newton's_code.create_fingerprints returned.
```

Say: half a real cohort meets a refusal before they ever see a score, so the
refusal is the product.

## Act 3: the commit

Make a one-line change in the demo clone, commit it, push it.

Say: the score belongs to a commit. An uncommitted worktree is refused before
anything reaches the hosted runner at all, on purpose, because a leaderboard
row is a claim about code somebody can go read. (The refusal is "Commit your
changes before hosted verification.", and it fires on Verify hosted, which
starts a practice run.) Then `cogworks sync` puts the local result on the
dashboard, marked as local and self-reported, and the hosted run is what turns
it into a verified one.

## Act 4: the site

1. **Dashboard**, the runs and the two counters.
2. **A run page**: the finding sentence, the metrics, the diagnostics.
3. **Team**: the five stages of the capstone with the people who committed to
   them. Do not promise a headcount from the stage: a teammate who committed
   under two identities appears twice, so read what is on screen.
   This is the multi-person answer. The team is the repository: anyone with
   push access who signs in is a member, so there is no roster to maintain.
4. **Leaderboard**, Song Identification.

## What to say if asked

- **Is the scoring real?** Yes, on both surfaces, and it is the same code.
  The demo repository scored 0.5375 in the terminal and 0.5375 on the hosted
  runner. Two hosted runs of it have finished: 133 seconds on 2026-09-04 and
  2 minutes 11 seconds on 2026-09-09.
- **What about cheating?** The official set is hidden, it never enters the
  sandbox that runs student code, and every team gets three official attempts.
- **What does it cost the course?** No lecture time. Connect a repository and
  run three commands.
