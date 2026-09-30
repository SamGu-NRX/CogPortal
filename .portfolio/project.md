---
# kgu.one builds this project's page from this file (https://kgu.one/projects/cogportal).
# When a change alters what the project does, its results, awards, stack or links,
# update this file in the same change. Rules:
# - Facts only, each one backed by this repo, the resume or a public source.
# - No em dashes and no middle dots.
# - line: at most 120 characters, ending in a period. What someone does or gets,
#   then one mechanism. No adjectives.
# - The paragraph after this header: 50 to 80 words, first person. What it is, who
#   used it, the hard part, one fact.
title: CogPortal
kind: project
date: 2026-07
line: Grades capstone projects on hidden tests, finding each team’s code by what it does, not what it’s named.
award: MIT BWSI
stack: [Python, React, Cloudflare Workers, Modal]
links:
  - label: Portal
    href: https://cogportal.sillion.app/
  - label: Code
    href: https://github.com/SamGu-NRX/CogPortal
---

I built CogPortal from scratch as lead TA for MIT BWSI’s Cog*Works. A pip-installable CLI runs the course’s four benchmarks offline or in a network-blocked Modal sandbox, a React and Hono portal on Cloudflare Workers ranks every run on a live leaderboard, and a Discord bot posts the results. The hard part is discovery: it finds each team’s functions by code structure, not names, and scored all 15 teams.
