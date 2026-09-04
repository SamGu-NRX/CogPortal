# Pitch walkthrough

Deck, terminal, website, in that order. The site is
https://cogportal-dev.sillion.app, deployed from this branch.

## Before anyone is watching

Do these in order. The order matters and the reason is given.

1. **Connect the demo repository.** Sign in on the site, go to Team, Change
   repository, and pick `SamGu-NRX/cogportal-demo-week1`. Grant the GitHub App
   access to it when prompted. That repository is a fork of a real 2026 week 1
   capstone and carries the original team's history: eight contributors across
   the five stages of the assignment. Your own CogPortal repository has one
   contributor, which is why the team page said "only one person has touched"
   every stage.

2. **Start one audio run.** The team page reads the stage names from your
   team's most recent run, not from the repository, so with a vision run last
   the page looks for vision stages in an audio repository and finds nothing.
   One practice run on Song Identification fixes it. Do this before the pitch,
   not during.

3. **Open the terminal in the demo clone** and warm the caches:

   ```sh
   cd ~/BWSI/2026/CogPortal/.cache/demo/cogportal-demo-week1
   cogworks check --benchmark audio-identification
   ```

   The second run of `check` is faster than the first because the resolution is
   memoized per commit. Run it once now so the demo is the fast one.

## Act 1: the claim, in a terminal

```sh
cogworks check --benchmark audio-identification
```

Under two seconds, and it prints the five functions it will call:

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

Forty seconds to a real score with diagnostics that name which half of the
pipeline lost the points.

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

Say: the score belongs to a commit. An uncommitted change is refused for the
official run on purpose, because a leaderboard row is a claim about code
somebody can go read. Then `cogworks sync` puts the local result on the
dashboard, marked as local and self-reported, and the hosted run is what turns
it into a verified one.

## Act 4: the site

1. **Dashboard**, the runs and the two counters.
2. **A run page**: the finding sentence, the metrics, the diagnostics.
3. **Team**: the stages of the capstone with the eight people who touched them.
   This is the multi-person answer. The team is the repository: anyone with
   push access who signs in is a member, so there is no roster to maintain.
4. **Leaderboard**, Song Identification.

## What to say if asked

- **Is the scoring real?** The terminal scoring is real and is the same code
  the sandbox runs. Hosted runs on this deployment are scripted unless the
  Modal provider is switched on.
- **What about cheating?** The official set is hidden, it never enters the
  sandbox that runs student code, and every team gets three official attempts.
- **What does it cost the course?** No lecture time. Connect a repository and
  run three commands.
