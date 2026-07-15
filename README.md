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
- The included vision plugin contains small public contract fixtures, not the
  final course dataset or scorer.
- The template catalog is intentionally empty until canonical course-owned
  repositories and immutable GitHub repository IDs exist.
- Nothing in this change deploys services, publishes Python packages, creates
  cloud resources, or registers Discord commands.

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
benchmarks/vision-recognition/ Public benchmark plugin/contract fixtures
template-catalog/            Immutable metadata for separately owned templates
docs/                        Architecture decisions, scope, and operations
```

Student template repositories stay independent GitHub repositories. They are
not Git submodules and are not copied into this monorepo.

## Local development

Requirements: Node 24+, pnpm 10.30.3, and Python 3.8+ (Python 3.11 for the Modal
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
python -m pip install -e python/cogbench -e benchmarks/vision-recognition -e examples/week2-vision-submission
cogbench doctor --benchmark vision-recognition
cogbench test --benchmark vision-recognition
cogbench run --benchmark vision-recognition
cogbench report
```

CogBench local commands do not require a CogPortal account or network after
the project and plugins are installed. The bundled submission is a synthetic
development example, not a student capstone implementation; real student
templates remain separately owned repositories. `cogbench link` and
`cogbench sync` are optional, explicit actions.

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
