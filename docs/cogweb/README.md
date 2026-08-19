# CogWeb, mirrored

The complete CogWorks course textbook: all 84 pages and 125 figures from
<https://rsokl.github.io/CogWeb/>, captured 2026-08-17 by
`tools/capture/fetch_cogweb.py`. None of it is ours. The prose, code, math, and
figures belong to the course authors (Ryan Soklaski et al.), mirrored here as
course staff so the benchmarks can be designed and reviewed against what
students are actually taught rather than against a summary of it.

`docs/capstones/` holds a curated subset of the same material, edited for
readability and annotated. This directory is the unedited whole, and when the
two disagree this one is right.

## What is here

`pages/` mirrors the site's own directory structure: `Audio/`, `Video/`,
`Language/`, `Math_Materials/`, `Cheat_Sheets/`, plus the top-level module
overviews. Files keep their authored extension, `.md` for MyST markdown pages
and `.ipynb` for notebooks. `media/` holds every figure any page references.
`manifest.json` records the source URL, every page with its title and byte
count, every image, and the empty failure list.

Start here for benchmark work:

| Page | Why it matters |
|---|---|
| `pages/Audio/capstone_summary.md` | The Week 1 assignment: fingerprinting, the peak/fanout parameters, the `mlab.specgram` settings, the analysis students are asked to produce. |
| `pages/Video/FacialRecognition.md`, `pages/Video/Whispers.md` | The Week 2 assignment: FaceNet descriptors, cosine distance, the cutoff, and the clustering algorithm. |
| `pages/Language/SemanticImageSearch.md` | The Week 3 assignment: COCO shapes, IDF-weighted GloVe caption embeddings, the 512→200 encoder, margin ranking loss. |
| `pages/{Audio,Video,Language}/prereqs.md`, `pages/pre_reqs.md` | Exactly what a student has installed, per week and per platform. Ground truth for anything a runner image assumes. |
| `pages/Audio/Exercises/PeakFinding.md`, `spectrogram.md` | The exercises the Week 1 code is built out of. A metric students cannot trace back to one of these is a metric that will read as a mystery. |

## How it was captured

Sphinx publishes each page's pre-render source under `_sources/<doc>.<ext>.txt`,
so these are the authors' markdown and notebooks rather than a lossy
HTML-to-markdown conversion. The page list comes from the site's
`searchindex.js`, which enumerates all 84 pages, so nothing depends on
following links and no page is missed. The fetcher is polite by construction:
one request at a time with a delay, a User-Agent naming the course, and it
skips anything already on disk.

Nothing was edited. The `.txt` suffix Sphinx adds for serving is dropped so
files keep their authored extension; that is the only difference from what the
server returns.

## Rules

Do not edit these files to match our naming or our benchmark's shape. To
refresh, re-run the fetcher and note the new date here. If the course changes
what it asks students to build, that is a new benchmark version on our side,
never an edit here.
