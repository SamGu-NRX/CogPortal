---
# kgu.one builds this project's page from this file (https://kgu.one/projects/cogportal).
# When a change alters what the project does, its results, awards, stack or links,
# update this file in the same change. Rules:
# - Facts only, each one backed by this repo, the resume or a public source.
# - No em dashes and no middle dots.
# - line: at most 120 characters, ending in a period. What someone does or gets,
#   then one mechanism. No adjectives.
# - The body opens with one paragraph of 50 to 80 words, first person: what it is,
#   who used it, the hard part, one fact. The site uses it as the summary.
# - The rest of the body is the full write-up, in plain Markdown (## and ###
#   headings, lists, emphasis, inline code, https links), at most 1,500 words.
title: CogPortal
kind: project
date: 2026-07
line: Demo day, before demo day. Cog*Works teams benchmark their capstones on a laptop, then on hidden tests in a sandbox.
stack: [Python, React, Cloudflare Workers, Modal]
links:
  - label: Portal
    href: https://cogportal.sillion.app/
  - label: Code
    href: https://github.com/SamGu-NRX/CogPortal
---

I built CogPortal from scratch as lead TA for Cog*Works, the pre-college machine learning course at MIT’s Beaver Works Summer Institute. Teams practice locally with a pip-installable CLI, then run their capstones against hidden test labels in a network-blocked Modal sandbox. A portal on Cloudflare Workers shows each team’s chosen official result on a live leaderboard, and a Discord bot posts the results. It has scored two real Week 1 team repositories end to end in that sandbox.

## Where it came from

On July 24, an instructor gave up a lunch break to build a demo-day benchmark by hand. He pulled captions from COCO at three levels of difficulty, randomized which ones each team got so nobody could tune to them, and ran every team live on the projector. Half of it failed, and the room treated that as normal. It was a held-out evaluation done right, and it existed only because one person improvised it. CogPortal builds that hour into software.

## Three levels of trust

- Local practice. `cogworks check` works offline after install, and `test` and `run` work offline once the public data and models they fetch on first use are cached. None of them needs an account. The CLI never uploads source, paths, datasets or predictions, and any result you sync is marked self-reported.
- Hosted practice. The same code runs in a Modal sandbox that gets inputs but no secrets and no network. The hidden labels stay with a trusted controller outside it.
- Official evaluation. An official run has to reuse the exact artifact from a successful practice run at the same commit, and attempts are limited.

The CLI covers the four benchmarks written for the course: song identification, face recognition, face clustering and caption-to-image search.

## Finding code nobody labeled

The runner asks for very little. It can find a team’s code through one `submission.py` at a known path, because when we checked all 13 real 2026 team repositories, none had Python packaging, and a tool that demands packaging from high schoolers fails on day one.

I also wrote a discovery step for repositories without that file. It finds a team’s functions however they’re named, split or wrapped in classes, by calling them in sequence and keeping only a chain that passes the benchmark’s own test, such as naming an enrolled song back from a two-second clip. It reproduces two instructor-written adapters’ scores to four decimal places and clears the 13-repository corpus in 36 seconds. Before profiling, one repository alone took 272 seconds.

## Rules the build enforces

Two rules are tests, not guidelines. A benchmark that explains its metrics in the course’s own vocabulary has to explain every metric it labels, or the build fails; older benchmarks without explanations are skipped. And the signals the portal derives from a team’s process can’t carry a per-person number, because a seventeen-year-old reads any per-person number as a grade.

Hosted runs go through a staging beta with its own Modal app, and production waits on the release gates in the deployment runbook. I’m now working with BWSI to extend CogPortal to the institute’s other courses, starting with a connector for the Edly LMS.
