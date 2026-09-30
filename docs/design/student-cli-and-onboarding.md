# Student CLI and onboarding

**Status:** implemented pilot contract

**Audience:** CogWorks students, instructors, and release maintainers

**Last reviewed:** 2026-07-17

## Product decision

The portal teaches one path from a course-owned GitHub starter to a locally
checked adapter. Setup finishes before students implement or score a model.

```text
create or join a team
→ fork the starter into the team's GitHub organization
→ clone that verified fork
→ install the CogWorks CLI and project
→ link this machine to CogPortal
→ run one local check with an explicit setup update
→ begin implementing
```

The Python distribution, executable, and import package intentionally have
different names:

| Surface | Name | Why |
| --- | --- | --- |
| Package index | `cogworks-benchmark` | The `cogworks` distribution name is already occupied. |
| Terminal executable | `cogworks` | This is the short student-facing product name. Console-script names are independent of distribution names. |
| Python import | `cogbench` | Existing SDK compatibility; students normally do not import it directly. |

The pilot install is:

```sh
python -m pip install --upgrade "cogworks-benchmark @ git+https://github.com/SamGu-NRX/CogPortal.git@fix/product-description-triage#subdirectory=python/cogbench"
```

TestPyPI is a release proof, not the permanent course channel. After the
cross-platform pilot passes, publish the same reviewed distribution to PyPI and
replace only the install command shown by the portal.

## Why linking comes first

`cogworks link --portal <origin>` is the first intentionally online CLI action.
It uses a short-lived browser device-authorization flow so the student never
pastes an API token. After approval, the terminal stores a revocable device
credential for that exact portal origin and returns normally.

The link screen and terminal disclose the boundary before authorization:

- setup updates may include coarse check names, CLI and Python versions,
  installed benchmark/adapter IDs, and the normalized GitHub repository name;
- CogPortal never receives source, local paths, raw logs, environment variables,
  predictions, datasets, or scores as setup evidence;
- linking does not turn on background reporting.

If linking cannot reach CogPortal, the CLI prints the network failure and exits
2. It does not mark the device linked, wait in the background, or queue a retry.

## Local commands and setup updates

The ordinary commands remain local even after a device is linked:

```sh
cogworks check --benchmark vision-recognition
cogworks test --benchmark vision-recognition
cogworks run --benchmark vision-recognition
cogworks report
```

The optional `--update-setup` flag changes only the end of a successful local
command:

```sh
cogworks check --benchmark vision-recognition --update-setup
```

The CLI completes the local work first, prints its normal output, then sends one
authenticated HTTPS POST to `/api/v1/cli/setup/checks`. This is a synchronous
client callback, not a webhook: the student's process initiates it, the portal
does not call the laptop, and no listener or TUI is required.

| Situation | Terminal result | Exit |
| --- | --- | --- |
| Local check fails | Print the local diagnostic; send nothing. | 2 |
| Local check passes, flag omitted | Print success; send nothing. | 0 |
| Local check and setup update pass | Print local success and `setup: updated …`. | 0 |
| Local check passes, portal update fails | Preserve local success, print the portal failure and retry command; queue nothing. | 2 |

No retry is hidden inside setup reporting. This makes the result legible to a
student and safe to run repeatedly; the server upserts evidence idempotently.

The server derives the user and team from the device credential. It rejects a
repository that differs from the team's connected GitHub repository and accepts
only the enumerated coarse steps. User IDs, team IDs, source data, and arbitrary
extra fields are not accepted from the CLI payload.

## Canonical student setup

CogPortal renders commands with the real portal origin and repository URL. From
the instructor-provided course environment, the sequence is:

```sh
git clone https://github.com/TEAM/REPOSITORY.git
cd REPOSITORY
python -m pip install --upgrade "cogworks-benchmark @ git+https://github.com/SamGu-NRX/CogPortal.git@fix/product-description-triage#subdirectory=python/cogbench"
python -m pip install -r requirements-cogbench-pilot.txt
python -m pip install -e .
cogworks link --portal https://PORTAL-ORIGIN
cogworks check --benchmark vision-recognition --update-setup
```

Use `python -m pip`, not bare `pip`, so installation targets the active Python
environment. Editable project installation registers the starter's adapter
entry points and makes later code changes visible without reinstalling.

`check` verifies:

- supported local Python and the CLI version;
- a Git worktree with a GitHub `origin` remote;
- installed benchmark and submission entry points;
- loadability of the benchmark and adapter contracts;
- exact repository identity when setup evidence is sent.

`check` does not grade the project or populate large model/data caches. The
student can therefore complete setup with the scaffold before implementing the
recognizer or clustering algorithm.

## Standalone starter boundary

Students fork a separate, clean-history, course-owned starter repository. It is
not a submodule or a copy of the control-plane repository and contains no
reference implementation.

The prepared candidate lives in the separate `week2-vision-capstone`
repository. Before exposing it in CogPortal:

1. Review and publish it under the course GitHub organization.
2. Record its immutable numeric GitHub repository ID and reviewed revision in
   `template-catalog/catalog.json`.
3. Configure the portal's template repository setting.
4. Verify that organization forks retain the expected GitHub fork ancestry.

The starter owns only:

- project packaging and editable-install metadata;
- thin recognition and clustering adapter factories;
- scaffold tests that protect interface shape;
- a pilot requirements file pinning the upstream benchmark by commit.

Benchmark implementation, scoring, hidden data, reference solutions, portal
credentials, and runner secrets stay outside the starter. The pinned upstream
benchmark is consumed directly during the pilot; do not republish another
author's package without explicit authority.

## Command/network matrix

| Command | Network by default | What crosses the boundary |
| --- | --- | --- |
| `cogworks check` | No | Nothing |
| `cogworks test` | Only explicit public cache acquisition when needed | Public benchmark assets requested by the benchmark package |
| `cogworks run` | Only explicit public cache acquisition when needed | Public benchmark assets requested by the benchmark package |
| `cogworks report` | No | Nothing |
| Any of the first three with `--update-setup` | One setup POST after local success | Coarse evidence listed above |
| `cogworks link` | Yes | Device authorization request and token polling |
| `cogworks status` | Yes | Device authentication/status request |
| `cogworks sync` | Yes | One explicitly selected structured self-reported report |
| `cogworks run --live` | Yes | Coarse run progress and final structured report |

Stored credentials never make an offline command online by themselves.

## Portal information architecture

The setup page preserves the scientific field-notebook visual language while
making the journey sequential. Each item has one trust state:

- **portal verified** for GitHub/team facts observed by CogPortal;
- **CLI checked** for local evidence sent by an explicit flagged command;
- **linked** for device authorization;
- **self checked** only for a student decision CogPortal cannot observe.

The day-zero progress rail covers team, people, clone, tool, project, link, and
check. Test, run, report, live sharing, and syncing are taught in a separate
“use next” panel so students do not mistake a working model for a setup
prerequisite.

Organization guidance belongs before repository selection. The portal should
recommend a free GitHub organization for teams, explain inviting teammates and
keeping two owners, link directly to organization creation, and still support a
personal fork for solo work.

The written steps remain complete without media. For the optional 45–75 second
GitHub walkthrough, follow `docs/runbooks/onboarding-media.md`.

## Replay and reset

The setup URL remains available from the account menu after completion.
Owner-only controls can be enabled explicitly in dev or staging:

- creator replay and member replay visually mask progress without changing
  stored state;
- reset deletes only the current owner's setup evidence and local guide
  checkboxes;
- reset never deletes the team, repository connection, device, membership,
  report, or GitHub state;
- the reset route behaves as not found when the environment flag is disabled.

This separation lets instructors rehearse onboarding safely while preserving
real connected resources.

## Release and acceptance gates

The core wheel must pass before TestPyPI publication:

- build both wheel and sdist from a clean source tree;
- install the wheel in a new environment with no repository source on
  `PYTHONPATH`;
- run bare `cogworks`, `cogworks --help`, `cogworks --version`, and
  `python -m cogbench --version` without error;
- verify `pip check` and inspect console entry points;
- verify the artifact contains no localhost or development portal default;
- verify an unflagged local command cannot call the setup endpoint;
- verify flagged local success plus network failure exits 2 and queues nothing;
- test macOS arm64 and Windows x64 course environments plus Python 3.11 parity.

TestPyPI trusted publishing requires the repository, workflow filename, and
`testpypi` GitHub environment to match the publisher configured on TestPyPI.
The version must be incremented for every uploaded artifact because package
indexes do not allow replacing a released file.

The portal gate includes strict contract tests, authenticated repository
matching, idempotent evidence writes, polling only while setup is visible, and
keyboard/reduced-motion checks. A five-student pilot should measure whether
students can reach “setup complete” without staff interpreting an error.

## Deliberately deferred

- automatic conda/environment repair;
- background retry or telemetry queues;
- production PyPI publication before the pilot evidence exists;
- republishing the upstream benchmark without owner permission;
- a documentation CMS or interactive tutorial engine;
- Cloudflare Stream until the course has enough video to need adaptive bitrate
  delivery or analytics.
