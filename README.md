# CogWorks benchmark platform

This repository is the control plane and developer tooling for CogPortal,
CogBench, CogBot, and the trusted benchmark runner. The design puts student
accessibility first: local practice works offline after installation, hosted
practice gives reproducible diagnostics, and official evaluation remains a
separate, attempt-limited trust tier.

## Honest status

- Portal, Discord interactions, account linking, the offline CLI, shared
  protocols, fixture execution, migrations, and CI are implemented.
- Modal execution is implemented behind a disabled provider gate. It must not
  be enabled until the live M0 isolation probe passes and course-owned hidden
  datasets are provisioned.
- The Week 2 vision benchmark is pinned as a submodule at a draft-PR commit.
  Public data and scoring are implemented; official data still requires private
  materialization and calibration before activation.
- The template catalog is intentionally empty until canonical course-owned
  repositories and immutable GitHub repository IDs exist.
- A clean-install workflow and manual TestPyPI trusted-publishing workflow are
  prepared, but nothing in this change deploys services, publishes Python
  packages, creates cloud resources, or registers Discord commands.

See [platform architecture](docs/architecture/platform.md), [MVP scope](docs/mvp.md),
and the [deployment runbook](docs/runbooks/platform.md) before enabling external
services.

## Repository map

```text
apps/portal/                 React portal + Hono Worker + D1 owner
apps/discord-bot/            Discord interactions Worker; Portal RPC client only
apps/runner-modal/           Trusted Modal controller and isolated sandboxes
packages/contracts/          TypeScript browser, API, RPC, and runner contracts
protocols/v1/                Language-neutral JSON Schemas and golden fixtures
python/cogbench/             Offline-first Python SDK and CLI
benchmarks/week2/             Pinned Week 2 benchmark submodule
benchmarks/vision-recognition/ Deprecated v1 fixture (retained temporarily)
template-catalog/            Immutable metadata for separately owned templates
docs/                        Architecture decisions, scope, and operations
```

Student template repositories stay independent GitHub repositories. Publish the
clean-history, interface-only `week2-vision-capstone` candidate to a course-owned
repository only after review, then add its immutable GitHub ID and revision to
the template catalog.

## Local development

Requirements: Node 24+, pnpm 10.34.5, and Python 3.8+ (Python 3.11 for the Modal
runner).

```sh
pnpm install --frozen-lockfile
cp apps/portal/.dev.vars.example apps/portal/.dev.vars
pnpm dev
```

`pnpm dev` applies local D1 migrations and starts CogPortal. With
`DEV_AUTH=enabled`, local sign-in accepts a development username; the seeded
cohort code is `VISION26`. After the monorepo move, an old root-level
`.dev.vars` is intentionally not loaded; copy only the values you still need
into `apps/portal/.dev.vars`.

For the student-style path, install the local packages into the already active
CogWorks prerequisite environment. Your environment may be named
`cogworks_week1`, `week1`, or `week2`; the name is not part of the contract.

```sh
conda activate cogworks_week1
git submodule update --init --recursive
python -m pip install -e python/cogbench -e "benchmarks/week2[data]" -e "benchmarks/week2/face_recognition_app[test]"
cogworks check --benchmark vision-recognition
cogworks test --benchmark vision-recognition
cogworks run --benchmark vision-recognition
cogworks test --benchmark vision-clustering
cogworks run --benchmark vision-clustering
cogworks report
```

CogWorks local commands do not require a CogPortal account. The first real-data
run fetches only the fixed public-manifest images and the FaceNet checkpoint;
later runs reuse verified caches. The standalone starter contains no capstone
solution. `cogworks link`, `--update-setup`, `--live`, and `cogworks sync` are
the explicit network boundaries; merely storing a linked-device credential does
not make ordinary commands contact CogPortal.

Using `python -m pip` and a single-line install command keeps the instructions
the same in macOS/Linux shells, Windows Command Prompt, and PowerShell. Platform
developers who do not use the course conda environment may use any Python 3.8+
virtual environment instead.

## Verification

```sh
pnpm check
pnpm test
pnpm db:migrate:local
pnpm build
```

The Discord worker scripts retain a narrow staging workaround for checkouts
whose parent directories contain glob metacharacters. It keeps one live source
tree, uses a temporary path without metacharacters, and removes that path when
Wrangler exits.

## Non-negotiable boundaries

- GitHub is the primary user identity; Discord and CLI devices are revocable
  links to that account.
- CogBot has no D1 binding and calls only the Portal's typed private service
  entrypoint.
- CogBench never uploads source, paths, datasets, environment variables, raw
  logs, or predictions. Synced results are visibly self-reported and can never
  be promoted.
- Hidden labels exist only in the trusted Modal controller. Evaluation
  sandboxes receive inputs, have no secrets, and have outbound networking
  blocked.
- Official runs must reuse the exact prepared artifact from a successful
  hosted practice run at the same commit.
- Fixture execution remains the safe default until the external M0 gate is
  explicitly completed.
