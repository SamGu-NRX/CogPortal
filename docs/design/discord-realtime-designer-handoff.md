# CogWorks realtime run experience: designer handoff

**Status:** implemented foundation, ready for interaction design
**Primary audience:** product and interaction designers working on CogBot, the
Discord Activity, and the matching CogPortal run console
**Last reviewed:** 2026-07-15

## 1. The product in one sentence

A student starts a benchmark from their own terminal, and their team can watch
the safe progress of that same run in one quiet Discord message and a richer
live console; if the code is committed and pushed, the team can verify the
exact commit on hosted infrastructure, promote that verified artifact to an
official attempt, and choose whether to publish the result.

The experience should feel like a shared lab bench, not CI software wearing a
course logo.

## 2. The central design object: one run surface

A **run surface** is one immutable attempt and its complete provenance. It owns:

- one public message in the team's private Discord channel;
- one deep-linked page in CogPortal;
- one live view in the Discord Activity;
- one exact Git commit SHA;
- the structured event history for local, hosted, and official stages;
- the authorized actions currently available to the team.

The surface moves through four stages:

```text
LOCAL → HOSTED → OFFICIAL → PUBLISHED
```

- **Local** is self-reported execution on a student's computer.
- **Hosted** is an unofficial practice verification of the exact clean SHA.
- **Official** is a quota-limited hidden evaluation reusing the successful
  hosted artifact.
- **Published** means the team deliberately selected that official result for
  the public leaderboard.

This is not a generic pipeline where every box must run. A student may stop
after local or hosted. Publication is an explicit choice.

An intentional rerun creates a new run surface and a new Discord message. It
never rewrites history. Repeated clicks on the same action are idempotent and
return the existing result instead of spending another attempt.

## 3. The system the interface is reflecting

```text
student CLI or hosted runner
        │
        │ allowlisted structured events
        ▼
     CogPortal
  D1 history + realtime hub
      │          │           │
      ▼          ▼           ▼
 one edited   Discord      CogPortal
 Discord      Activity     web console
 message      live UI      live UI
```

CogPortal is the authority. Student machines never log in to Discord and never
receive a bot token or webhook. The CLI authenticates to CogPortal through a
browser-assisted device flow. The student's CogPortal account is already
GitHub-authenticated, belongs to a team, and has a repository connection before
Discord is linked.

The Discord link is not a second account system. A signed Discord interaction
attaches that Discord identity to the existing GitHub-first CogPortal account.

### What crosses the network

The CLI and hosted runner emit server-understood events such as:

```text
repository.ready
dependencies.installing
contract.checking
contract.passed
evaluation.started
evaluation.progress
scoring.started
run.completed
run.failed.contract
```

Events may include elapsed time and a real `{ current, total, unit }` count.
The runner sends a heartbeat roughly every two seconds during long work. A
bounded client reporter preserves phase transitions and terminal events while
coalescing expendable progress updates.

Raw stdout, local paths, environment variables, predictions, dataset contents,
and secrets never enter the public event stream. A public UI must never create
the impression that it is a terminal mirror. It is a safe projection of the
run, owned by the server.

### How realtime behaves

- D1 stores the durable event history.
- One Durable Object instance per surface owns connected WebSockets and the
  latest projection.
- Portal and Activity clients receive accepted events immediately.
- Discord edits are coalesced so the bot edits one message without fighting
  rate limits; phase changes and terminal states take priority.
- A reconnecting viewer receives a current snapshot before subsequent events.
- If the Discord message is deleted or its initial creation fails, the next
  event safely recreates it.

The Activity and Portal are true web realtime surfaces. A Discord message can
only appear dynamic through edits; Discord does not permit custom CSS or
continuous animation inside a normal message.

## 4. Jobs to be done

### Student running locally

> Let my team see that I am working and where the run is, without dumping my
> terminal or requiring me to narrate it in chat.

### Teammate dropping in

> Tell me within a glance whether this is still moving, where it stopped, and
> whether I can help take the next action.

### Student verifying online

> Prove that the clean commit I just ran locally also works in the course
> environment, without accidentally evaluating some newer branch head.

### Team using an official attempt

> Make the cost and target of this action unmistakable before we spend an
> attempt, then keep us on the same run surface while it executes.

### Team publishing

> Let us choose the result we want to represent us, with a clear confirmation
> that this changes the public leaderboard.

### TA helping a team

> Show enough safe state to identify the failed phase and recovery action,
> while keeping private implementation details in the student's terminal.

## 5. Division of responsibility between the surfaces

The public Discord message and the Activity must not compete to show the same
amount of information.

### Discord message: awareness and the next action

The message is a compact team-channel artifact. It should answer only:

1. Which lifecycle stage is active?
2. Which benchmark, SHA, and person started it?
3. Is it moving, and what is the latest safe step?
4. What is the one useful next action?

Running example:

```text
✓ LOCAL  ● HOSTED  ○ OFFICIAL  ○ PUBLISHED
Face Recognition · a1b2c3d · by Sam · 21s · SIMULATED

  00:02  Repository ready
  00:06  Contract passed
  00:21  Evaluating · 18/40

On the bench · evaluating

[Open live console] [Open Cog*Portal]
```

Terminal example:

```text
✓ LOCAL  ○ HOSTED  ○ OFFICIAL  ○ PUBLISHED
Face Recognition · a1b2c3d · by Sam · 49s · SIMULATED

Bench clear · 0.913

[Open live console] [Verify hosted] [Run again] [Open Cog*Portal]
```

The rolling tail is at most three server-owned lines. Repeated heartbeats with
unchanged semantic progress collapse in the projection. Terminal messages
collapse the tail and emphasize result, duration, SHA, and next action.

The lifecycle uses marks as well as color: `✓` completed, `●` active, `○`
pending, and `×` failed. Color is reinforcement, never the only meaning.

### Activity and Portal: understanding and action

The Activity and web page reuse the same `RunConsole` component. They provide:

- lifecycle rail;
- current step and accessible progress;
- safe event history;
- score and metric label when known;
- exact SHA, branch, workspace state, and actor;
- server-authorized actions and confirmations;
- recent run selection;
- reconnect and stale-state recovery.

The Activity should feel lighter than the Portal even though the component is
shared. In Discord picture-in-picture and grid layouts, it switches to a
compact presentation that keeps identity, current progress, and lifecycle but
omits the detail/action column. Focused mode can show the complete console.

## 6. Information hierarchy for the live console

The current foundation uses this order:

1. **State eyebrow:** `ON THE BENCH · EVALUATING`, `BENCH CLEAR`, or a precise
   stopped state; simulated execution is visibly marked.
2. **Benchmark identity:** human benchmark name, actor, SHA, elapsed time.
3. **Current step:** a plain-language label and real progress bar when a count
   exists. This is the visual focus while running.
4. **Lifecycle rail:** all four stages, always visible in focused mode.
5. **Safe event stream:** chronological evidence, secondary to the current
   step.
6. **Reference and actions:** SHA, branch, clean/dirty state, and actions.

For terminal states, the hierarchy changes:

1. result or useful failure category;
2. benchmark, SHA, and duration;
3. next action;
4. collapsed three-line summary;
5. optional full event history.

Do not preserve the spatial hierarchy of a running console after it completes.
A result is a decision surface, not a frozen loading screen.

## 7. What felt bulky, and what the foundation changed

The first live Activity screenshot exposed several structural problems:

- the content ignored Discord's safe-area insets and sat too close to the top
  and side chrome;
- the page itself scrolled behind Discord's bottom Activity tray;
- the action column did not appear until a very wide breakpoint, producing a
  long single-column card inside a desktop Activity;
- completed runs retained an oversized log region and required unnecessary
  scrolling;
- the score was repeated in both the status sentence and metric panel;
- terminal surfaces still said `Live`;
- every heartbeat looked like another meaningful log line;
- local-stage progress could leak into a later hosted stage projection.

The implemented foundation now:

- uses Discord's safe-area CSS variables with browser fallbacks;
- fixes the Activity shell to `100dvh` with one internal scroller;
- switches to the two-column console at the medium breakpoint;
- collapses terminal history to three events with `Show all` disclosure;
- shows a single score treatment;
- says `Complete`, `Stopped`, or `Cancelled` at terminal;
- coalesces semantically unchanged heartbeat projections;
- scopes progress to the run that owns the current stage;
- exposes a semantic `role="progressbar"` with real bounds;
- keeps all four lifecycle stages visible;
- supports a compact Discord grid/PIP mode;
- keeps content clear of Discord's control tray.

The large open field beneath a short completed card is currently deliberate:
the shell owns the Activity viewport and refuses to scroll under Discord
controls. A designer can decide whether focused terminal states should use a
slightly denser centered composition, but should not reintroduce a page-height
card merely to fill space.

## 8. State-by-state behavior the designer should prototype

### A. No active run

- Show the team's latest surface and a quiet empty-state path to the CLI.
- Do not show a fake progress rail or disabled wall of actions.
- Copy should give one command or link, not a tutorial.

### B. Local preparing and contract checking

- Current step is primary; elapsed time proves the surface is alive.
- Indeterminate progress may move subtly, but it cannot imply a percentage.
- The Discord tail changes only on meaningful phase transitions.

### C. Local evaluating with known total

- Show `0/40` at start and real counts only when the adapter knows them.
- The progress bar should update without flashing or replaying entrance motion.
- If the runner only knows start and completion, do not fabricate intermediate
  cases to make the animation look busy.

### D. Local succeeded, clean SHA

- Emphasize metric, duration, and `Verify hosted`.
- Verification copy must say this is still a practice/unofficial run.
- The exact SHA is visible before confirmation.

### E. Local succeeded, dirty workspace

- No verify action.
- Privately explain that hosted verification requires a commit and push.
- Do not shame the student; `Workspace has uncommitted changes` is sufficient.

### F. Hosted practice running

- The same surface changes from local complete to hosted active.
- Reset the progress treatment for the hosted run; never carry `3/3` from
  local into a new hosted evaluation.
- Label this as practice/unofficial in words, not only color.
- Hosted preparation and evaluation use the same event vocabulary as local.

### G. Hosted practice succeeded

- Emphasize `Promote to official` and that the successful hosted artifact will
  be reused.
- Confirmation shows benchmark, exact SHA, and attempt number such as `2 of 3`.
- A hosted rerun creates a new surface rather than mutating this result.

### H. Official running

- Keep the same lifecycle surface and show `OFFICIAL active`.
- Hide official diagnostic logs. The safe stage projection can still say
  preparing, evaluating, or scoring.
- Avoid celebratory animation while the quota-bearing attempt is unresolved.

### I. Official succeeded, not published

- Score and remaining context are prominent.
- `Publish result` opens a confirmation explaining that the public leaderboard
  selection changes.
- Closing or pressing `Esc` leaves publication untouched.

### J. Published

- The lifecycle closes with all four stages complete.
- The terminal surface can acknowledge publication quietly; no confetti, ping,
  or automated team mention.
- The leaderboard may later show movement or rank delta, but that should not
  turn every run surface into a game notification.

### K. Failure, cancellation, and connection loss

- Failure copy names the safe category and tells the student where the useful
  detail remains: usually their terminal.
- Connection loss is visually distinct from run failure. Preserve the last
  known state, show `Reconnecting`, and recover in place.
- Do not clear the log or reset progress on reconnect.
- A late terminal snapshot wins over a stale reconnect banner.

## 9. Motion direction

Motion should communicate a state change, not prove that the interface is
modern.

### Recommended choreography

- **Phase change:** 140–180 ms opacity plus 2–4 px vertical movement on the
  current-step label. Use an ease-out curve.
- **Progress update:** animate only the bar's transform/width from the previous
  real value. Do not replay an entrance animation.
- **New event:** one restrained 120–160 ms opacity/position entrance. Existing
  lines remain still.
- **Lifecycle transition:** change the mark and label together; a short opacity
  crossfade is enough.
- **Dialog:** 160–220 ms fade/scale from approximately 0.98. Focus moves into
  the dialog immediately and returns to the invoking control on close.
- **Terminal transition:** current progress resolves, result replaces the live
  step, and event history collapses as one coordinated change. Avoid stacking
  independent animations.

### Rules

- Prefer transform and opacity; do not animate layout-heavy properties during
  heartbeat updates.
- Never animate every two-second heartbeat if the visible meaning is unchanged.
- Honor `prefers-reduced-motion`; reduced motion removes travel and looping
  indeterminate effects while preserving immediate state changes.
- No bouncing gears, mascot loaders, pulsing whole cards, particle effects, or
  fake terminal typing.
- Autoscroll only while the viewer remains at the bottom. If they scroll up,
  hold position and reveal a `New events` control.

## 10. Responsive Discord layouts

Discord can render an Activity in focused, grid, and picture-in-picture modes,
plus desktop and narrow mobile viewports. The interface must not assume it owns
the whole browser.

### Focused desktop

- Full current-step surface and four-stage lifecycle.
- Event stream and reference/actions may form a two-column lower region.
- The shell, not the document, owns scrolling.

### Narrow focused/mobile

- Preserve state, benchmark, current progress, and lifecycle before history.
- Stack event stream and actions.
- Controls have at least a 44 px target and respect safe-area insets.
- Long benchmark, team, and actor names truncate without hiding SHA or state.

### Grid and picture-in-picture

- Use the compact console.
- Keep state, benchmark, actor/SHA, current step, progress, and lifecycle.
- Remove event history, run reference, selectors, and mutation controls.
- The focused Activity or Portal deep link is the path to details.

The implementation listens to Discord's layout-mode event rather than guessing
from width alone. Width media queries still handle ordinary responsive layout
inside each mode.

## 11. Interaction and authorization rules

Rendered eligibility is never authorization. Every mutation re-resolves the
Discord account link, current team membership, current GitHub OAuth session,
and current repository permission.

- Current `admin`, `maintain`, and `write` collaborators may verify, rerun,
  promote, and publish.
- Verification rejects a dirty worktree and an exact SHA that has not been
  pushed to the connected GitHub repository.
- Promotion and publication require private confirmation.
- Repeated clicks return the already-created run or selection.
- A missing, expired, or revoked GitHub session gets one private `Sign in to
  GitHub` recovery action.
- Public Discord controls never expose private error or authorization detail.

The Activity must keep mutation errors local to the action area. A failed
button must not replace the entire live console with an error screen.

## 12. Sharing and notification model

There is intentionally no global notification-preferences system in the first
version.

- `cogbench run --live` is the student's explicit per-run decision to share a
  local surface.
- The team-channel binding decides where shared runs appear.
- The bot edits quietly and does not mention teammates.
- Running without `--live` remains local and creates no Discord surface.

This is easier to understand than hidden defaults such as “share all my local
runs unless muted.” If real course use shows channel overload, add a team-level
policy later—likely `manual`, `hosted and official only`, or `all live runs`—
rather than a matrix of personal notification toggles.

## 13. CogWorks identity and tone

The emotional model is a workshop: careful, curious, warm, and matter-of-fact.
Use the voice rules in [voice.md](./voice.md).

Good examples:

- `On the bench · evaluating`
- `Bench clear · 0.913`
- `Stopped during evaluation · the useful detail is in your terminal`
- `Push a1b2c3d to GitHub first`
- `This uses official attempt 2 of 3`

Avoid:

- fake celebration (`Amazing job! 🚀`);
- blame (`You broke the contract`);
- enterprise CI jargon when plain language works;
- noisy emoji, automatic pings, and reaction gamification;
- calling simulated fixture execution official.

The Cog mascot belongs in empty and successful moments, not as a perpetual
spinner and not in errors. Warmth should come from clear help, honest limits,
and small course-specific language rather than decoration.

## 14. Leaderboard and future fun

The leaderboard is the best place for playful course energy, but it should
reward learning rather than chat volume.

Promising directions for later discussion:

- a quiet rank-delta or personal-best treatment after publication;
- a weekly team showcase for an interesting technique or demo, separate from
  raw score rank;
- opt-in Activity challenges tied to the audio, vision, and language units;
- a semantic image-search “mystery query” challenge once the capstone hosting
  and content-safety boundary exists;
- opening a team's finished course app as a Discord Activity only after there
  is an approved hosting, permission, and sandbox model.

Do not add streaks, reaction currencies, constant rank-change messages, or
arbitrary student code inside Discord as a near-term extension. Those create
moderation and security systems, not small UX features.

## 15. What is implemented versus still gated

### Implemented foundation

- GitHub-first CogPortal identity and Discord account attachment;
- browser-assisted CogBench device authorization and `cogbench status`;
- `cogbench run --live` structured event reporting;
- one edited Discord message per lifecycle;
- D1 run surfaces and event history;
- Durable Object WebSocket hub;
- reusable Portal/Activity `RunConsole`;
- Activity OAuth and Discord Embedded App SDK authentication;
- exact-SHA hosted verification services;
- hosted, official, rerun, promotion, and publication action services;
- current GitHub permission rechecks and idempotent mutations;
- server-owned safe event copy and public redaction;
- Discord safe-area, compact layout, reduced-motion, keyboard, reconnect, and
  terminal-collapse foundations.

### Gated or not yet proven as production execution

- the production deployment still uses a visibly `SIMULATED` fixture provider;
- real Modal hosted and official evaluation remains disabled behind its
  security gate;
- non-developer student distribution and private-channel permissions require a
  final course-guild acceptance pass;
- arbitrary student apps cannot yet run as Activities;
- richer leaderboard play and notification policy are design discussions, not
  committed scope.

The designer should prototype real hosted and official states now because the
state model and services exist. User research and visual review must never
describe the fixture runner as a real official evaluation.

## 16. Required prototype and acceptance matrix

Every interaction proposal should be shown and tested in all three execution
contexts:

| Context | Running | Succeeded | Failed | Reconnect | Primary next action |
| --- | --- | --- | --- | --- | --- |
| Local/self-reported | preparing, contract, evaluating, scoring | clean and dirty variants | contract, runtime, timeout | CLI offline and Activity reconnect | Verify hosted or Run again |
| Hosted practice/unofficial | preparing, evaluating, scoring | exact SHA verified | unpushed SHA, revoked OAuth, runner failure | hosted callback pause | Promote official or Rerun hosted |
| Official | preparing, evaluating, scoring without private logs | scored, unpublished and published | quota/runner failure | delayed terminal result | Publish result |

Also verify:

- focused desktop, narrow mobile, grid, and picture-in-picture;
- keyboard-only use, visible focus, `Esc` dialogs, and screen-reader labels;
- reduced motion and high contrast;
- slow network, reconnect, duplicate delivery, and joining mid-run;
- long names and large event histories;
- the bottom Discord control tray never covers content;
- scrolling up never forces the viewer back to the bottom;
- one run creates exactly one public message and a rerun creates exactly one
  new message.

## 17. Design decisions that should remain stable

These are product and safety boundaries, not visual preferences:

- one public Discord message per lifecycle;
- CogPortal is the authority;
- raw local logs remain local;
- local results never become official directly;
- hosted verification targets the exact clean pushed SHA;
- an official run reuses a successful hosted artifact;
- confirmations protect official attempts and public leaderboard changes;
- every mutation rechecks authorization on the server;
- Discord message density stays low; the Activity and Portal hold detail;
- deliberate reruns preserve history by creating a new surface;
- simulated execution is always visibly labeled.

Within those boundaries, the designer should feel free to change composition,
typography, density, motion choreography, disclosure patterns, and the visual
expression of the CogWorks workshop identity.
