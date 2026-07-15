# Student CLI, setup, and documentation experience

**Status:** design and delivery plan \
**Primary audience:** CogWorks students using an instructor-provided prerequisite environment \
**Secondary audience:** TAs helping students recover from setup failures \
**Last reviewed:** 2026-07-14

## 1. Decision summary

CogBench should feel like one small, dependable instrument rather than another
course project. The student journey is:

```text
activate the existing course environment
→ install the student project and CogBench
→ verify the adapter
→ run a local public benchmark
→ optionally link CogPortal
→ explicitly sync a self-reported result
```

The documentation should teach that journey in the same order. It should not
start with architecture, Modal, Cloudflare, entry-point internals, or Discord
administration.

The first documentation release includes:

- one public Getting Started page;
- one complete CLI reference;
- one troubleshooting page organized by the error a student sees;
- contextual help on the Connections and benchmark pages;
- a focused device-authorization screen with complete loading, sign-in,
  expired, approval, success, and retry states.

It deliberately does not include a documentation CMS, interactive tutorial
engine, AI assistant, automatic environment repair, or separate native app.

## 2. What works today

The fixture implementation has been verified locally on macOS in the existing
`cogworks_week1` conda environment with Python 3.8.20 and in a Python 3.14
virtual environment.

| Capability | Current status | Important boundary |
| --- | --- | --- |
| Editable package installation | Verified | Uses a synthetic development submission adapter |
| `cogbench doctor` | Verified | Checks discovery; it does not reproduce the hosted environment |
| `cogbench test` | Verified | Runs one public synthetic contract case |
| `cogbench run` | Verified | Runs all public synthetic cases locally |
| `cogbench report` | Verified | Reads a saved local structured report |
| `cogbench link` | Verified end to end | Requires a running portal and a signed-in user with a connected team |
| `cogbench sync` | Verified end to end | Uploads one explicit structured report as self-reported |
| `cogbench run --live` | Implemented, integration-gated | Requires a linked device, connected repository, team-channel mapping, and Discord availability |
| Hosted practice through Modal | Not enabled | Fixture execution remains the safe default |
| Official hidden evaluation | Not enabled | Blocked on the Modal M0 security gate and real benchmark ownership |
| PyPI production default | Not ready | The package currently defaults to the development portal origin |

“Verified” therefore means the current placeholder/local workflow works. It
does not mean the synthetic score is an official benchmark, that Modal is
production-ready, or that the current wheel is ready to publish.

## 3. Explain the two Python versions clearly

The current doctor output includes:

```text
python                   3.8.20
canonicalHostedPython    3.11
```

These are not competing requirements:

- `python` is the interpreter running CogBench on the student's machine.
- `canonicalHostedPython` is the standardized interpreter planned for hosted
  preparation and evaluation.
- Python 3.8 is the student compatibility floor because the course prerequisite
  environments use it.
- Python 3.11 is the hosted target because the Modal runner is standardized on
  it.

The wording should become less ambiguous before release:

```text
localPython              3.8.20
hostedEvaluationPython   3.11
localPythonSupported     True
```

A version difference should be informational when the local version is
supported. `doctor` should fail only for an unsupported interpreter or missing
plugin, and should provide one concrete recovery command for each failure.

## 4. Student jobs to be done

### Primary job

> When I finish or change my capstone implementation, I want to check that it
> installs and satisfies the benchmark contract, so I can find integration
> problems before spending an official attempt.

### Linking job

> When I have a local result worth sharing with my team, I want to connect this
> device to my CogPortal account, so I can upload only that report without
> uploading my project or granting submission authority.

### Recovery job

> When setup fails on my machine, I want the error message and documentation to
> agree on one next action, so I can recover without understanding package
> metadata, OAuth, or the portal architecture.

## 5. Canonical setup guide

The site and repository README must show the same sequence. Start from the
repository root in the instructor-provided conda environment.

```sh
conda activate cogworks_week1
python -m pip install -e python/cogbench -e benchmarks/vision-recognition -e examples/week2-vision-submission
cogbench doctor --benchmark vision-recognition
cogbench test --benchmark vision-recognition
cogbench run --benchmark vision-recognition
cogbench report
```

The published student template will replace the monorepo-relative install with
the smaller student command:

```sh
conda activate week2
python -m pip install cogworks-benchmark cogworks-vision-benchmark
python -m pip install -e .
cogbench doctor --benchmark vision-recognition
```

Use `python -m pip`, not a bare `pip`, so the installer and `python` refer to the
same environment. Keep install commands on one line so they work unchanged in
macOS/Linux shells, Windows Command Prompt, and PowerShell.

### Supported environment promise

For the student release, test:

- macOS arm64 with the course Python 3.8 conda environment;
- Windows x64 with the course Python 3.8 conda environment;
- a clean Python 3.11 environment matching hosted evaluation;
- editable installs from paths containing spaces;
- offline `doctor`, `test`, `run`, and `report` after installation;
- a weak/interrupted network for `link` and `sync` recovery.

CogBench must not declare PyTorch, OpenCV, Facenet, Jupyter, or course-model
dependencies. Those belong to the student prerequisite environment and project.
The CLI/adapter boundary should remain lightweight and standard-library-first.

## 6. CLI command reference to publish on the site

### `cogbench doctor`

```sh
cogbench doctor --benchmark vision-recognition
cogbench doctor --benchmark vision-recognition --json
```

Use before debugging a score. It checks the local interpreter, Git repository,
benchmark plugin, and submission entry point. JSON output is for support and CI.

### `cogbench test`

```sh
cogbench test --benchmark vision-recognition
cogbench test --benchmark vision-recognition --json
```

Runs one fast public contract case. It answers “can CogBench import and call my
adapter?” rather than “how good is my model?”

### `cogbench run`

```sh
cogbench run --benchmark vision-recognition
cogbench run --benchmark vision-recognition --json
```

Runs the complete public local practice fixture and saves a report under
`.cogbench/reports/`. The result is always `LOCAL · SELF-REPORTED`.

Optional explicit team projection:

```sh
cogbench run --benchmark vision-recognition --live
cogbench run --benchmark vision-recognition --live --portal http://localhost:5173
```

`--live` should remain opt-in. It updates one team-channel progress message and
must not stream logs, predictions, source, files, environment variables, or
datasets.

### `cogbench report`

```sh
cogbench report
cogbench report .cogbench/reports/local_example.json
```

Without a path, shows the newest local report in the current project.

### `cogbench link`

Production student command:

```sh
cogbench link
```

Local platform-development command:

```sh
cogbench link --portal http://localhost:5173
cogbench link --portal http://localhost:5173 --no-browser
```

The command creates a short-lived, single-use device authorization. A URL such
as `/connections?user_code=8EC0-509A` is expected: the readable code lets the
student confirm that the terminal and browser refer to the same request. The
secret device code stays in the CLI process and is never placed in the URL.

### `cogbench sync`

```sh
cogbench sync
cogbench sync .cogbench/reports/local_example.json
cogbench sync --portal http://localhost:5173
```

Uploads one explicitly selected structured report. It never promotes the result
to official and never uploads the project, local paths, raw logs, datasets,
environment variables, or predictions.

## 7. Portal-origin behavior and PyPI release rule

The resolution order should remain:

```text
explicit --portal
→ COGPORTAL_URL environment override
→ packaged production origin
```

Development documentation must always use an explicit local override:

```sh
cogbench link --portal http://localhost:5173
```

The published PyPI wheel must default to the final stable HTTPS production
origin, not localhost and not a staging or `-dev` hostname. Do not add dynamic
service discovery or a remote configuration dependency in v1; a small explicit
constant is easier to audit and works offline until a network command is chosen.

Before publishing a wheel:

1. Ratify the stable production origin and configure the portal, GitHub OAuth
   callback, Discord links, and Worker `PUBLIC_ORIGIN` with the same value.
2. Move the Python default into one named configuration module rather than
   leaving it embedded in CLI parsing.
3. Keep `--portal` and `COGPORTAL_URL` as developer/operator overrides.
4. Build the wheel from a clean tagged commit.
5. Install that wheel on macOS and Windows without repository source present.
6. Run `cogbench link --no-browser` and assert that the printed URL uses the
   stable production origin.
7. Reject the release automatically if the wheel contains `localhost`, a
   `-dev` hostname, or an unpublished runner digest.

## 8. Device-link experience

### Intended flow

```text
[CLI starts authorization]
          ↓
[Browser opens /connections?user_code=XXXX-XXXX]
          ↓
     {signed in?}
       ↙       ↘
     no         yes
     ↓           ↓
[GitHub sign-in] [validate code]
     ↓           ↓
[return to exact authorization URL]
          ↓
  {account has connected team?}
       ↙                 ↘
     no                   yes
     ↓                     ↓
[finish cohort/team setup] [approve named device]
       ↘                 ↙
        [CLI receives token]
                  ↓
      [success + return to terminal]
```

The current account/team requirement is intentional because synced reports are
owned by a team. The UI must explain this before redirecting rather than making
the authorization appear broken. After cohort/team setup, it must return to the
still-valid authorization automatically; if it has expired, it should ask the
student to rerun `cogbench link`.

### Required page states

| State | Page behavior | Primary action |
| --- | --- | --- |
| Session loading | Show “Checking your CogPortal session…” | None |
| Session request failed | Explain connection failure; never spin forever | Retry |
| Signed out | Explain that GitHub sign-in returns to this request | Continue with GitHub |
| Missing cohort/team | Preserve the return URL and explain the prerequisite | Finish setup |
| Code valid | Show code, device name, scope, expiry, and revocation promise | Approve device |
| Code expired/used | Explain that nothing was linked | Run `cogbench link` again |
| Approval pending | Disable duplicate submission and show immediate progress | None |
| Approved | Confirm success and direct attention back to terminal | Open Connections / Close tab |
| Approval failed | Keep the device name and show an actionable error | Try again |

### Focused wireframe

```text
┌──────────────────────────────────────────────────────┐
│ Cog*Portal                               Account     │
├──────────────────────────────────────────────────────┤
│ COGBENCH DEVICE                                      │
│                                                      │
│ Connect this terminal                                │
│ Confirm that your terminal shows:  688B–A015         │
│                                                      │
│ Device name                                          │
│ [ Sam's laptop                                  ]    │
│                                                      │
│ This device may upload selected self-reported        │
│ results. It cannot read source or start official     │
│ evaluations. You can revoke it at any time.          │
│                                                      │
│ [ Approve device ]          [ Cancel ]               │
└──────────────────────────────────────────────────────┘
```

Use a 44px minimum target for both actions, visible keyboard focus, a real form
label, and `role="status"`/`role="alert"` for asynchronous outcomes.

## 9. Site documentation information architecture

### Public `/docs` landing page

Keep four choices only:

1. **Get started** — environment, install, entry point, first test.
2. **Use CogBench** — the six command families above.
3. **Connect accounts** — GitHub identity, CLI device, Discord connection.
4. **Fix a problem** — symptom-first troubleshooting.

### Contextual documentation

- Landing/setup: install and `doctor` commands with a copy button.
- Dashboard empty state: `test`, `run`, and the meaning of local/self-reported.
- Connections: `link`, approval scope, expiry, sync, and revocation.
- Run failure card: one copyable reproduction command linked to the matching
  troubleshooting section.
- Discord `/cog`: link back to Connections rather than duplicating setup prose.

Do not put operator deployment, D1, Modal secrets, Discord command registration,
or incident response in student-facing documentation. Those remain in the
repository runbook.

## 10. Visual and interaction direction

Preserve the existing restrained “scientific instrument / course notebook”
identity: warm paper, strong ink, detector red for attention, verification green
for completed trust actions, serif headings, and compact monospaced metadata.
Documentation should feel authored for CogWorks rather than like a generic SaaS
help center.

The device flow should be visually focused: one authorization panel, one primary
action, and no leaderboard/dashboard distractions below the fold until approval
is complete.

| Current behavior | Designed behavior |
| --- | --- |
| Indefinite generic loading mark | Specific loading label, bounded timeout, then retry state |
| Authorization panel appears among all connections | Focused authorization first; connection inventory follows after completion |
| Generic rise animation on route content | One 180–220ms `ease-out` entrance on the focused panel |
| No explicit approval transition | Replace the panel with success using matched 180–220ms opacity/transform timing |
| Motion assumed | Disable every transition and animation under `prefers-reduced-motion: reduce` |

Animate only `opacity` and `transform`. Do not animate the code, progress text,
layout height, or frequently used documentation navigation. Button press feedback
may use `scale(0.97)` for 100–150ms on fine pointers; hover-only effects must be
guarded for devices that actually support hover.

## 11. Troubleshooting content map

Organize by visible symptom, not subsystem:

| Student sees | Explain | Recovery |
| --- | --- | --- |
| `submissionInstalled False` | Student adapter entry point is missing from the active environment | Activate the intended conda environment; install the project editable; rerun `doctor` |
| More than one plugin installed | Two different adapters claim the same benchmark | Uninstall the example or obsolete submission; do not delete the environment blindly |
| `Connection refused` | No portal is listening at the requested local origin | Start `pnpm dev` or remove the local `--portal` override |
| Browser stays on “Loading…” in development | Stale HMR/client state or failed session request | Hard refresh; UI must then expose retry/error rather than spin indefinitely |
| Device code expired | Short-lived request was not approved in time | Rerun `cogbench link`; never reuse an old URL |
| “Portal is not linked” | No unexpired token exists for this exact portal origin | Run `cogbench link` against the same origin |
| Live sharing needs a commit | Repository is dirty/uncommitted or lacks GitHub metadata | Commit the intended state before `--live` |
| Channel is unbound | Portal accepted the run, but Discord has no mapped team channel | Team maintainer maps the channel through `/cog` |
| Local Python differs from 3.11 | Local and hosted versions are intentionally distinct | Continue if `localPythonSupported` is true; use 3.11 only for parity debugging |

## 12. Acceptance tests

### CLI contract

- All commands return `0` on their documented success path and `2` on a
  recoverable user/configuration failure.
- Help text and site command reference are generated from or checked against one
  command manifest so they cannot silently drift.
- `doctor --json` remains stable and versioned for TA support scripts.
- Offline commands make no network requests.
- Network commands clearly print the selected portal origin.
- Tokens are scoped by normalized portal origin, expire, and are revocable.
- Sync strips local-only fields and stays visibly self-reported.

### Browser flow

- Opening a valid device URL while signed out preserves the complete return URL
  through GitHub OAuth.
- A student who still needs cohort/team setup returns to the device request when
  setup completes.
- Invalid, expired, approved, and consumed codes never render an active approval
  button.
- Double submission creates at most one device.
- Refreshing every state is safe and understandable.
- Keyboard-only and reduced-motion flows pass.

### Release matrix

- macOS arm64 + course Python 3.8.
- Windows x64 + course Python 3.8.
- Linux + Python 3.11 hosted-parity environment.
- Clean wheel install without monorepo source.
- Local fixture portal and stable production portal.

## 13. Delivery phases

### P0 — make the existing path dependable

- Surface session-query errors instead of rendering an indefinite spinner.
- Validate device-code status before rendering approval.
- Preserve device authorization through sign-in and required team onboarding.
- Rename the Python-version doctor labels.
- Add the command reference and troubleshooting content to repository docs.
- Ratify the stable production origin; do not publish to PyPI before this.

**Done when:** a new student can follow one page from install through a linked,
synced fixture report on macOS and Windows without staff interpreting an error.

### P1 — publish the documentation surface

- Add a lightweight public `/docs` route using repository-owned Markdown or
  statically authored content; no CMS.
- Add contextual links from setup, Connections, empty dashboard, and failure
  states.
- Add copy buttons with accessible confirmation.
- Run a five-student fixture pilot and record where assistance was required.

**Done when:** at least four of five pilot students complete setup unaided and
all can identify that local results are self-reported.

### P2 — production package release

- Replace the development default with the ratified production origin.
- Build and inspect the wheel from a clean tag.
- Run the cross-platform release matrix.
- Publish to TestPyPI, repeat the clean install/link/sync flow, then publish to
  PyPI only after approval.

**Done when:** `cogbench link` from the published wheel opens the stable
production portal without flags and the wheel contains no development origin.

### Deferred until evidence exists

- Interactive environment repair.
- A documentation search service.
- Video walkthroughs.
- Notebook extension or IDE integration.
- Multi-course/multi-portal discovery.
- CLI auto-update behavior.
- AI troubleshooting.

## 14. Scope decision log

| Decision | Status | Rationale |
| --- | --- | --- |
| Keep one production origin compiled into the wheel | Accepted for v1 | Most dependable student default; overrides still support developers |
| Add a static student docs surface | Accepted for P1 | Directly addresses observed setup and linking confusion |
| Keep local sync explicit | Accepted | Preserves privacy and avoids misleading automatic results |
| Show live progress only with `--live` | Accepted | Avoids Discord noise and unexpected network activity |
| Build a documentation CMS | Rejected | Adds operations and authoring complexity without current need |
| Auto-install/repair course dependencies | Deferred | High cross-platform risk; prerequisite environments remain course-owned |
| Treat local and official results equally | Rejected | Breaks benchmark trust and hidden-evaluation boundaries |
