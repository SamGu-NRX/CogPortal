# CogWorks capstone source material

This directory holds the CogWorks course's own descriptions of the three capstone
projects and of the environment students install, captured from
[CogWeb](https://rsokl.github.io/CogWeb/) on 2026-08-16. None of it is ours. The
prose, code, math, and figures are the course authors' (Ryan Soklaski et al.),
reproduced here so that our benchmarks are designed against what students are
actually told to build rather than against our recollection of it. When the
benchmark and this directory disagree, this directory is right and the benchmark
is wrong.

## Files

| File | What it captures | Source |
|---|---|---|
| [`week1-audio-capstone.md`](week1-audio-capstone.md) | Song recognition: fingerprinting, the peak/fanout parameters, the `mlab.specgram` settings, and the performance analysis the course asks for. Audio module overview appended. | [Audio/capstone_summary.html](https://rsokl.github.io/CogWeb/Audio/capstone_summary.html), [audio.html](https://rsokl.github.io/CogWeb/audio.html) |
| [`week2-vision-capstone.md`](week2-vision-capstone.md) | Face recognition (FacenetModel, 512-D descriptors, cosine distance, the cutoff) and the Whispers clustering algorithm that forms part 2. Vision module overview appended. | [Video/FacialRecognition.html](https://rsokl.github.io/CogWeb/Video/FacialRecognition.html), [Video/Whispers.html](https://rsokl.github.io/CogWeb/Video/Whispers.html), [vision.html](https://rsokl.github.io/CogWeb/vision.html) |
| [`week3-language-capstone.md`](week3-language-capstone.md) | Semantic image search: COCO 2014 data shapes, IDF-weighted GloVe caption embeddings, the 512→200 linear encoder, margin ranking loss, and the published hyperparameters. | [Language/SemanticImageSearch.html](https://rsokl.github.io/CogWeb/Language/SemanticImageSearch.html) |
| [`environment.md`](environment.md) | What a student has installed: conda env names, Python version, package lists, per-week and per-platform. Ground truth for anything the portal or a runner assumes about their machine. | [pre_reqs.html](https://rsokl.github.io/CogWeb/pre_reqs.html), [Audio/prereqs.html](https://rsokl.github.io/CogWeb/Audio/prereqs.html), [Video/prereqs.html](https://rsokl.github.io/CogWeb/Video/prereqs.html), [Language/prereqs.html](https://rsokl.github.io/CogWeb/Language/prereqs.html) |
| `media/` | 27 figures referenced by the pages above, downloaded from `_images/`. Image links in the markdown point here. | `https://rsokl.github.io/CogWeb/_images/` |

## How it was captured

Sphinx publishes each page's pre-render source under `_sources/`, so these files are
the authors' markdown rather than a lossy HTML-to-markdown conversion. Three
mechanical edits were applied: the jupytext YAML header and `#raw`/`#region` cell
markers were removed, and the centered `<img>` divs were rewritten to markdown links
into `media/`. LaTeX is untouched. The page list came from the site's
`searchindex.js`, which enumerates all 84 pages.

`environment.md` carries one section we wrote: a table at the top summarizing the
per-week environments. It is labeled as ours, and every cell restates a line from the
verbatim text below it.

## Rules

Do not edit these files to fit our design, our naming, or our benchmark's shape. If
something here is wrong or stale, re-capture it from the source URL and note the new
fetch date. If the course changes what it asks students to build, that is a benchmark
version change on our side, not an edit here.
