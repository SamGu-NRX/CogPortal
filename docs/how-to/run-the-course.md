# How to run a CogWorks cohort on CogPortal

This guide is for instructors and TAs on a portal that is already deployed. To
host one, follow [how to deploy your own CogPortal](deploy-your-own.md) first.
Students have their own guide in
[`python/cogbench/README.md`](../../python/cogbench/README.md), which covers the
website steps and every command they type.

Everything below happens in the admin console at `/admin`.

## Know who can do what

The portal has three staff roles, and they are not a ladder.

| Role | Where it comes from | What it can do |
| --- | --- | --- |
| Owner | A GitHub login in the deployment's `PLATFORM_OWNER_LOGINS`. Changing it needs a redeploy. | Everything: the join code, enrollment, the staff roster, TA assignments, and every team. |
| Staff | A login an owner adds under **PLATFORM STAFF**. | Reach the console. Staff who aren't also assigned to teams see an empty TA workspace. |
| TA | An owner assigns them to one or more teams. | Add and remove members on those teams. |

An owner sees the heading **Admin**. Everyone else sees **TA workspace**, with
only their assigned teams and no join code.

Being staff doesn't open a team's run pages or its Team page. Those carry the
team's unpublished practice results and its process notes, so the portal
shows them only to the team's members. To look at a run with a team, have a
member open it.

## Open a cohort

1. Sign in with a login listed in `PLATFORM_OWNER_LOGINS`, then open
   **Admin** from the account menu or go to `/admin`. The portal first offers
   to join the cohort; an owner doesn't need to.
2. Under **COHORT**, rotate the join code if the current one has been shared
   anywhere you don't control. **Rotate join code** asks you to confirm, and
   the old code stops working at once. There is no undo, so do it before you
   hand the code out.
3. Under **PLATFORM STAFF**, add the GitHub login of each instructor or TA who
   needs the console. A login can go on the roster before its owner has
   signed in.
4. If **COHORT** reads "enrollment closed", select **Open enrollment**. Then
   give students the code.
5. Once everyone is in, select **Close enrollment**. A student who tries the
   code afterwards sees "That code doesn't match.", the same message as a
   typo, so for a late student reopen enrollment rather than resending the
   code.

## Check which benchmarks are open

Students can start hosted runs only for active benchmarks. Synced local
reports for an inactive benchmark or version still show on the dashboard,
under **Other benchmarks**. Semantic image search and both Week 2
vision tracks are active. Week 1 song identification is inactive on purpose:
its calibration showed that the shipped query grid does not separate a tuned
pipeline from a crippled one, so a hosted number would mislead
([`0020_week1_audio.sql`](../../apps/portal/migrations/0020_week1_audio.sql)).
Students can still run it locally with the CLI, and the student guide gives
them its install line because the Setup page leaves inactive tracks out.

The admin console has no switch for this. Turning Week 1 on is the course
owner's decision, and it needs a new benchmark version whose grid does rank
pipelines.

## Keep teams moving

Each row under **TEAMS** shows the team, its repository, and how many hosted
practice runs and official attempts it has completed, counted across every
benchmark rather than against one allowance. Open a row to see its published
score and to manage it:

- Assign a TA by GitHub login. The TA must have signed in to the portal once.
- Add a member by GitHub login. They must have signed in and joined the
  cohort, and must not be on another team.
- Remove a member. Removal takes one click with no confirmation, and the
  team's creator can't be removed.
- Place a student from **UNASSIGNED STUDENTS** with **Assign to team…**.

Adding someone in the portal does not give them push access to the
repository. Add them as a collaborator on GitHub too, or they can't push the
commits their runs score.

## Help a stuck team

| The team says | Usually |
| --- | --- |
| "I joined but have no team" | They are under **UNASSIGNED STUDENTS**. Assign them, or have them join from the website. |
| "I can't join my team's repository" | Joining needs write access on GitHub. Have the team add them as a collaborator first. |
| "I can't push" | The portal roster changed but GitHub did not. Add them as a collaborator. |
| "Setup won't tick" | `check` needs `--update-setup` and a linked device, and it reports only after it passes. The terminal says what went wrong. |
| "A hosted run failed" | Failed runs use none of the team's allowance. If their code caused it, they fix it, push, and start a new practice run. Retry reruns the same commit. |
| "Our local score isn't on the leaderboard" | Synced local results are self-reported and never ranked. Only a published official run is. |

A team has ten completed practice evaluations and three completed official
evaluations per benchmark version. Local CLI runs are free and unlimited.

## Read results as findings

The portal reports what a run shows rather than grading anyone. A run page
leads with a sentence about where the pipeline holds and where it breaks, and
the number sits below it. The reasoning is in
[the instrument, not the judge](../design/the-instrument-not-the-judge.md).

The portal doesn't compute a score for any person. A team's own Team page has
a **Where the work went** panel, built from the repository's commits and the
team's runs. It says who touched each stage, never how much, and it shows no
per-person totals, percentages, or ordering of members. Being staff doesn't
open it.

## Rehearse locally before class

A local portal set up as in the root README's
[local development](../../README.md#local-development) section signs you in
with any made-up login and runs a fixture instead of real scoring, so it
rehearses the pages, not the benchmark. Those settings come from
`apps/portal/.dev.vars`, copied from `.dev.vars.example`; to open `/admin`,
put the login you'll use in its `PLATFORM_OWNER_LOGINS`. `pnpm dev` also loads
demo data: the join code `VISION26` and six demo teams with invented runs.

A made-up login isn't a GitHub login, so the console controls that look one
up (adding a member, assigning a TA, **Assign to team…**, removing a member)
can't find it; they say "User not found." or that the user must sign in, or do
nothing. Rehearse the student path instead by signing in as a student, joining
with `VISION26`, and choosing **Start a team** with the fixture repository
`cogworks-demo/face-finder`. That repository isn't on GitHub, so the Setup
page's clone line fails. Run the CLI instead from a local repository that
holds working code for the benchmark, with `origin` set to
`https://github.com/cogworks-demo/face-finder.git`. The CLI accepts plain HTTP
only for localhost, so `cogworks link --portal http://localhost:5173` works
against it. `check --update-setup` then ticks the Setup page, and `sync` after
a `test` or `run` shows the report on the dashboard.

Real GitHub sign-in, hosted scoring on Modal, and the Discord bot need the
deployed services in [the deploy guide](deploy-your-own.md), and a local
rehearsal proves none of them.
