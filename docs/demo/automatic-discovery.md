# What `cogworks check` does now, on real repositories

Everything here is copied from a run against the 2026 corpus. No repository
was edited and no wiring was written by hand for any of them.

## The problem this replaces

`cogworks check` used to print nine lines, seven of them `False`, and no next
step. Scoring a repository at all required an instructor to read the team's
code and write an adapter, which had been done for four of the thirteen.

## A repository that resolves

```
benchmark              audio-identification
python                 3.11.15
hosted python          3.8.20 (the hidden evaluation runs on this)
repository             carti4ce/week1_capstone

looked in              carti4ce__week1_capstone  (code sits at the repository root)
read                   7 files: database, database_creation, fingerprint, match, slicing, song_input, spectrogram
skipped                15 scripts that read files or a microphone this machine does not have

Wired up:
  spectrogram    spectrogram.make_spectrogram
  peaks          fingerprint.find_peaks
  fingerprints   fingerprint.make_fgp
  store          database.add
  query          match.query_details

Your code is wired up and ready to score.

Run `cogworks run --benchmark audio-identification` to score it on your machine.
```

Nothing was matched by name. Every one of those functions was called, its
output handed to the next one unchanged, and the whole chain kept only because
it enrolled two rendered songs and named the right one back from a two-second
clip.

A second team wrote the same pipeline in different files, with a database that
is a class rather than a module:

```
Wired up:
  spectrogram    create_spectogram.create_spectrogram
  peaks          find_peaks.find_peaks
  fingerprints   create_fingerprints.peaks_to_fingerprints
  store          database.AudioDatabase().store_fingerprints
  query          database.AudioDatabase().query
```

## The scores are the same ones a person got by hand

Two repositories have an instructor-written adapter, made by someone who read
the code. Those are the only ground truth for whether an automatic binding
found the right functions, and "it produced a number" is not the same claim as
"it produced the right number".

| repository | by hand | discovered |
|---|---|---|
| carti4ce/week1_capstone | 0.6562 | 0.6562 |
| KrazeeCoder/week1-capstone-team4 | 0.5938 | 0.5938 |

Every metric matches to four places, including `margin_separation` and
`ranking_failure_rate`, not only the headline score. This comparison runs as a
test (`benchmarks/week1/tests/test_discovered_repository_results.py`).

## A repository that is refused, usefully

The point of a refusal is that the next thing to do is visible in it.

```
looked in              Week1  (directory name matches this week)
read                   5 files: AudioSplicer, audio_parser, database_design, interfaceInspect, songrecognizer
from notebooks         AudioSplicer, audio_parser, database_design, interfaceInspect, songrecognizer (definitions only; the cells were not run)
could not read         fingerprint_database: imports ipynb, which is not installed here
could not read         fingerprint_maker: imports ipynb, which is not installed here

Wired up:
  spectrogram    audio_parser.spectrogram_conversion

Nothing in your repository took a tuple of 2, starting with an array of shape (1025, 171) for the fingerprints step, which is what audio_parser.spectrogram_conversion returned.

fingerprint_database and fingerprint_maker did not import, because ipynb is not installed here. If the function the benchmark is looking for lives in one of them, add ipynb to a requirements.txt at the root of your repository.
```

Their spectrogram was found and returns a shape. The step after it is named,
so is what it was offered, and so is the strongest lead: the two files that
could not be read are called `fingerprint_database` and `fingerprint_maker`.

No diagnosis appears anywhere in that report, and a test enforces it. The
platform cannot know whether their fanout is too narrow, and a confident wrong
guess costs more than saying nothing.

## Waiting

The search is bounded by pairings tried, and both numbers come from the search
itself rather than from a benchmark on somebody else's laptop.

```
Reading your repository
  read 16 files in KrazeeCoder__week1-capstone-team4
Looking for the functions that fingerprint a song
  spectrogram    create_spectogram.create_spectrogram
  peaks          find_peaks.find_peaks
  fingerprints   create_fingerprints.peaks_to_fingerprints
Trying your functions to find which pair stores a song and names it back
  ⠹ [####....................] 1,200/6,320 pairings   30s left at this rate
```

The attempts left are a ceiling, because the search stops at the first pairing
that works. The seconds are the average attempt so far multiplied out, which
is why the line says "at this rate" rather than naming a deadline. Nothing
draws unless the output is a terminal.

## How long it takes

| repository | cold | again, unchanged |
|---|---|---|
| carti4ce/week1_capstone | 0.2s | under 1s |
| KrazeeCoder/week1-capstone-team4 | 1.1s | under 1s |
| whole 13-repository corpus | 36s | |

The slow one took 272 seconds before a profile showed where the time went: 248
seconds re-rendering the same two fixture songs once per pairing, and 100 more
deep-copying lists of immutable tuples. Both were recomputing a constant.

A resolved binding is remembered under a key made from the bytes of every file
the search read, so editing any of them searches again. Timestamps are not in
the key, because a checkout, a branch switch, and a `git stash` all rewrite
those without changing code.
