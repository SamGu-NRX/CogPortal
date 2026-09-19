# CogPortal documentation

CogPortal is the benchmark portal for MIT BWSI CogWorks. Students connect their
team repository, run a course benchmark against held-out data, and read what the
run found. This page says where each kind of document lives.

The four sections below follow [Diátaxis](https://diataxis.fr): a document either
helps you do something or helps you understand something, and it does not try to
do both.

## Start here

If you are evaluating whether to host CogPortal, read
[about CogPortal's security and stored data](explanation/security-and-data.md).
It covers sign-in, what the portal stores, what it can reach on GitHub, how the
Discord bot works, how a run executes in its sandbox, and what the code cannot
tell you.

If you are about to host it, follow
[how to deploy your own CogPortal](how-to/deploy-your-own.md).

## How-to guides

Steps to a goal, for someone who already knows why they are doing it.

- [How to deploy your own CogPortal](how-to/deploy-your-own.md): a fresh
  installation in your own Cloudflare and Modal accounts.

## Explanation

Background and decisions, readable away from the product.

- [About CogPortal's security and stored data](explanation/security-and-data.md)
- [About CogPortal's two hosted environments](explanation/environments.md)

## Design and product decisions

- [`design/`](design/) holds the settled design positions.
  [The instrument, not the judge](design/the-instrument-not-the-judge.md) is the
  one every surface answers to, and [voice.md](design/voice.md) governs every
  string a student reads.
- [`decisions/`](decisions/) holds numbered decision records, such as
  [the Week 2 vision benchmark](decisions/0002-week2-vision-benchmark.md).
- [`vision/`](vision/) holds the owner's direction and the course evidence behind
  it, including
  [what the course actually taught](vision/what-the-course-actually-taught.md)
  with timestamps.
- [`mvp.md`](mvp.md) is the current scope line.

## Operations

- [`runbooks/`](runbooks/) holds the procedures for an installation that already
  runs. [platform.md](runbooks/platform.md) owns the production release gates,
  image publication, and rollback.
  [gate-1-modal.md](runbooks/gate-1-modal.md) is the ordered Modal checkout, and
  [rotate-signing-secret.md](runbooks/rotate-signing-secret.md) is the one
  procedure that spans three systems.
- [`architecture/platform.md`](architecture/platform.md) describes the pieces and
  how they talk to each other.

## Course material and behavior

- [`product-description/`](product-description/) describes, feature by feature,
  what the product does when a user acts. It is written from the code and
  verified against the running product.
- [`capstones/`](capstones/) holds the three weekly capstone briefs.
- [`cogweb/`](cogweb/) is a copy of the CogWorks course site, which is the source
  for environment names, Python versions, and prerequisites. Verify a command
  against it before changing one.
- [`demo/`](demo/) and [`pitch/`](pitch/) hold demo scripts and the Beaver Works
  pitch.
