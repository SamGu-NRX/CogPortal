# Demo machine setup

The demo runs against production, `https://cogportal.sillion.app`, from Sam's
Mac. Most of the setup is already done and has to stay that way, so this file
records the state, the commands, and the checks worth running on the day.
[The pitch walkthrough](pitch-walkthrough.md) covers what Sam says and points
here rather than repeating any of it.

Every identifier below was observed during the production rehearsal on
2026-09-15, against build `20889b5`. Run the checks in section 3 on the day.
Do not start a hosted evaluation to reconfirm a number already recorded here,
because each one spends a practice attempt.

## 1. What is already done

The account is through onboarding. This is the starting position, not a screen
to reset.

- Signed in as `@SamGu-NRX`, on team CogPortal in the BWSI CogWorks 2026 cohort.
- Connected repository `SamGu-NRX/cogportal-demo-week1`.
- Setup reports 5 of 5 verified for Audio.
- The CLI is paired to production as device `d940 production rehearsal`, which
  expires Nov 14.
- Discord user SamG is linked and the team channel is bound, so a hosted run
  posts its progress there.
- Two hosted practice runs are saved. Practice usage is 2 of 10, which leaves
  eight. No official attempt has been used.

Saved results to fall back on if anything live fails:

| Run | Score | Wall clock | Source |
| --- | --- | --- | --- |
| [`run_b647f110de`](https://cogportal.sillion.app/runs/run_b647f110de) | 0.5375 | 2m18s | `e515ff6` |
| `run_6c658516d2` | 0.5375 | 2m01s | `e515ff6` |

Ten of the eleven metrics the site displays match the saved local report
exactly. The one that differs is an unscored timing, which is what you would
expect from two different machines.

## 2. The environment

Three things carry the demo, and all three already exist.

**The student checkout** is `/Users/samgu/Programming Projects/CogPortal-rehearsal-student`.
It sits on branch `codex/demo-rehearsal-d9405278` at commit
`e515ff619e02c16be903985d8536bc5ee6d7a2e9`, which is pushed and clean. That
commit adds thirteen lines to `README.md` and nothing else. `main` is still at
`7125804`, untouched.

**The CLI** is an isolated virtualenv holding `cogworks` 0.2.0. It keeps its
configuration outside the global one, so nothing here disturbs another CLI on
this machine. Paste this block into the demo terminal before anything else. It
ends in the student checkout on purpose, because `check` and `run` read the
directory you are standing in:

```sh
cd '/Users/samgu/Programming Projects/CogPortal-rehearsal-student'
source /tmp/cogportal-rehearsal-venv/bin/activate
export COGBENCH_CONFIG=/tmp/cogportal-rehearsal-state/config.json
export PYTHONDONTWRITEBYTECODE=1
export NUMBA_CACHE_DIR=/tmp/cogportal-rehearsal-caches/numba
export MPLCONFIGDIR=/tmp/cogportal-rehearsal-caches/matplotlib
```

Those paths are all under `/tmp`, so a reboot or a cleanup sweep takes the
environment with them. Section 5 says what to do if that happens.

**The browser** is Helium, because it holds the signed-in session. Chrome is
also on this machine and is not the one to use. Open a new window rather than
reusing one of Sam's.

## 3. Checks on the day

Four checks, about two minutes. Each one has an expected result, so stop and
report anything else rather than working around it.

1. Confirm the CLI still points at production. After the export block above,
   run `cogworks status`. It prints `@SamGu-NRX`, team CogPortal, repository
   `SamGu-NRX/cogportal-demo-week1`, a chosen Discord team channel, the device
   name, its expiry, and `Portal   https://cogportal.sillion.app`. If the
   command is not found, the virtualenv is gone; see section 5.

2. Confirm the checkout is where the story starts:

   ```sh
   cd '/Users/samgu/Programming Projects/CogPortal-rehearsal-student'
   git status --short --branch
   git log -1 --oneline
   ```

   Expect `## codex/demo-rehearsal-d9405278...origin/codex/demo-rehearsal-d9405278`
   with no file lines, and `e515ff6`. If a tracked file is modified, report it
   and do not discard it.

3. Open `https://cogportal.sillion.app/setup` in Helium. It must show the
   CogPortal team and 5 of 5 verified. If it shows the sign-in page, tell Sam
   and let him sign in himself.

4. Open `https://cogportal.sillion.app/dashboard` and set the track to Song
   Identification. The run log is scoped to the selected benchmark, and the
   default selection is not necessarily Audio. Two succeeded runs at 0.5375
   should be listed.

## 4. Before the hosted run, match the branch

This is the one step that quietly produces the wrong demo. The dashboard's
**Branch** menu starts on the repository's default branch, which is `main`
(`apps/portal/src/routes/DashboardPage.tsx:334`). It does not follow the branch
you just pushed to. If Sam pushes to `codex/demo-rehearsal-d9405278` and then
clicks **Run practice benchmark** without touching the menu, the hosted run
scores `main` at `7125804`, and the commit he just made on stage is not the one
in the result.

Select `codex/demo-rehearsal-d9405278` in the **Branch** menu first, then start
the run. When the run appears, the panel reads
`practice · codex/demo-rehearsal-d9405278 · <short sha>`. Read that line once
before moving on.

If the branch is missing from the menu, the site is working from a stale branch
list for the repository. Reload the dashboard once. The menu falls back to the
default branch alone when it cannot read the list
(`apps/portal/src/routes/DashboardPage.tsx:67`).

## 5. If the /tmp environment is gone

The virtualenv and its configuration live under `/tmp`, so they do not survive
a reboot. If `cogworks` is missing or `cogworks status` reports no portal,
rebuild rather than improvise:

1. Create a fresh virtualenv outside any repository, and activate it.
2. Run the install commands from `https://cogportal.sillion.app/setup` in it.
3. Run `cogworks link --portal https://cogportal.sillion.app --no-browser`,
   then paste the printed URL into the Helium window that holds Sam's session.
   Approving the device needs his session, so ask him to press **Approve**.
4. Change into the student checkout, then confirm the wiring:

   ```sh
   cd '/Users/samgu/Programming Projects/CogPortal-rehearsal-student'
   cogworks check --benchmark audio-identification
   ```

   `check` and `run` both read the directory you are standing in
   (`project_root = Path.cwd()`, `python/cogbench/src/cogbench/cli.py:890`), so
   running either from the virtualenv's own directory inspects the wrong
   project and reports nothing useful.

Use `--no-browser`. Without it the CLI opens the system default browser, which
may not be the one holding the signed-in session.

Do not invent a credential, reset the setup guide, or create a second account
to get past a missing environment. The saved run at
`https://cogportal.sillion.app/runs/run_b647f110de` carries the demo on its own
if the CLI cannot be rebuilt in time.

## 6. What a fresh participant does

Sam's account is past all of this, and the walkthrough describes the path
rather than performing it. Keep the two apart on stage. A new participant:

1. Starts at `https://cogportal.sillion.app/signin` and signs in with their own
   GitHub account.
2. Enters the cohort join code, which an instructor gives out privately.
3. Picks a repository that account can reach through the GitHub app.
4. Installs Git and the course Audio prerequisites, then runs the versioned
   install commands listed on Setup.
5. Pairs their machine with `cogworks link --portal https://cogportal.sillion.app`
   and approves it in their own browser.

Discord linking is optional and starts with `/cog` in the course server.

## Do not

- Do not sign Sam in or out of anything.
- Do not use **Promote to official** during the walkthrough. Official attempts
  are 0 of 3 and should stay there.
- Do not press **Reset guide** if it appears on the Setup page. It clears the
  verified setup state, and the demo depends on that state reading 5 of 5.
- Do not commit, push, or discard anything in the student checkout beyond the
  one deliberate demo edit the walkthrough describes.
- Do not touch `apps/portal/.dev.vars` or any file holding a credential, and do
  not print the CLI configuration.
- Do not close windows, tabs, or editor buffers you did not open, and do not
  quit an application that was already running.
