# CogWorks Benchmark CLI

`cogworks` runs the course benchmarks against your team's repository on your
own machine. It tells you which of your functions it found, scores them on
public data, and saves a report you can keep or share with your team on
CogPortal. The package and the command have different names:

```text
install: cogworks-benchmark
run:     cogworks
module:  python -m cogbench
```

## Start on the website

The portal knows your team and your repository, so it prints the setup
commands with both already filled in. Each student does these once:

1. Sign in to CogPortal with GitHub.
2. Enter the join code your instructor gives you.
3. Make the team if nobody has yet, or join it if a teammate already did. The
   team's repository has to be public, and you need write access to it on
   GitHub.
4. Open **Setup** and pick your week's track at the top.

Copy the commands from the Setup page rather than from this file. The page
pins exact commits, and a pin copied from here can go stale.

## Set up your machine

Every command runs inside the conda environment you built for that week's
prerequisites on CogWeb, so activate it first:

| Track | `--benchmark` | Environment |
| --- | --- | --- |
| Week 1, song identification | `audio-identification` | `week1` |
| Week 2, face recognition | `vision-recognition` | `week2` |
| Week 2, clustering | `vision-clustering` | `week2` |
| Week 3, semantic image search | `language-search` | `week3` |

Then run the Setup page's lines in order. For Week 2 recognition they look
like this, with your repository and the current pins in place of the
placeholders:

```sh
conda activate week2
git clone https://github.com/<owner>/<repo>.git && cd <repo>
python -m pip install --upgrade --force-reinstall "cogworks-benchmark @ git+https://github.com/SamGu-NRX/CogPortal.git@<commit>#subdirectory=python/cogbench"
python -m pip install "cogworks-week2-vision-benchmark @ git+https://github.com/SamGu-NRX/cogworks-week2-vision-benchmark.git@<commit>" && python -m pip install --force-reinstall --no-deps "cogworks-week2-vision-benchmark @ git+https://github.com/SamGu-NRX/cogworks-week2-vision-benchmark.git@<commit>"
cogworks link --portal https://<your-portal>
cogworks check --benchmark vision-recognition --update-setup
```

A few of these look odd, and each oddity is there on purpose:

- `--force-reinstall` on the tool: the version number stays the same between
  pins, so without it pip keeps whatever commit you installed last time.
- The benchmark installs twice. The first command brings in its
  dependencies, and the second replaces an older copy of the same version
  without touching them.
- `link` opens the portal in your browser so you can approve this machine
  within ten minutes. On a machine without a browser, add `--no-browser` and
  open the printed link yourself. The link lasts 60 days.
- `--update-setup` is the only thing that lets `check` report back, and it
  reports only after `check` passes.

When `check` passes, the Setup page ticks its boxes within a few seconds and
the terminal prints what it sent, such as
`setup: updated clone, environment, project, wiring`. If a box doesn't tick,
the reason is in your terminal, not on the page.

Under the clone and the two install steps, the page also offers a one-line
`python -c` command next to "Done here?". Running it ticks that box as done by
you, which the page shows differently from a box CogPortal verified. Each
command carries a signed token that lasts about a week, so copy a fresh one if
it's refused.

Week 1 song identification isn't on the Setup page while its hosted runs are
off (see [Hosted runs and the leaderboard](#hosted-runs-and-the-leaderboard)).
To work on it locally, use the Setup page's tool line, then install the
benchmark with the pin current when this guide was last updated:

```sh
conda activate week1
python -m pip install "cogworks-week1-audio-benchmark @ git+https://github.com/SamGu-NRX/cogworks-week1-audio-benchmark.git@4e516f39ffbeefe579e093260b2865eb354c17a7" && python -m pip install --force-reinstall --no-deps "cogworks-week1-audio-benchmark @ git+https://github.com/SamGu-NRX/cogworks-week1-audio-benchmark.git@4e516f39ffbeefe579e093260b2865eb354c17a7"
cogworks check --benchmark audio-identification
```

Leave off `--update-setup` for Week 1, since the page has nothing to tick.

## Work locally

Local commands cost nothing and have no limit, so this is where most of the
work happens. Run them from your repository's root, with your track's ID from
the table above in place of `vision-recognition`:

```sh
cogworks check --benchmark vision-recognition
cogworks test --benchmark vision-recognition
cogworks run --benchmark vision-recognition
cogworks report
```

- `check` reads your repository and says which of your own functions it wired
  up, then either "Your code is wired up and ready to score." or what it
  couldn't find.
- `test` scores the benchmark's small test tier, which catches wrong shapes
  and crashes before a full run.
- `run` scores the public practice benchmark and saves a report under
  `.cogbench/reports/`.
- `report` prints the latest saved report again, or the one you name.

`--benchmark` is required on `check`, `test`, and `run`. Add `--json` for
output a script can read. Each command exits 0 when it succeeds and 2 when it
doesn't; a low score still exits 0.

The end of one team's saved Week 1 report:

```text
Median identify time: 0.030 s
Margin separation (AUC): 0.774
commit: 7125804 (dirty)
note: Identification falls gradually from 68% at 5 songs to 54% at 30, without a single point where it breaks.
note: 21% of queries had the right song somewhere in the list but not near the top.
```

The first `test` or `run` of a week can download that week's public data and
model files, so expect it to be slower than the ones after it.

Commit before you run. A report records the commit it ran on, and it says
"(dirty)" when the working tree had uncommitted changes, which means nobody
can check out exactly the code that produced it. Hosted runs score a commit
on GitHub, so push the commit you mean before you start one.

## Trained weights

Week 3's image encoder is trained, so its score depends on a weights file
your code loads, such as `data/W_embed.npy`. You don't declare it: the
benchmark finds the file your code loads, and `run` keeps a copy of the exact
bytes it read under `.cogbench/weights/`.

If git already carries the file, nothing more is needed. If it doesn't, get
the weights to a hosted run this way:

1. Commit and push the code that loads the weights.
2. Run `cogworks run --benchmark language-search` on that commit.
3. Run `cogworks sync`. It uploads the copy the run read, up to 100 MiB per
   file, not whatever sits at that path now.
4. Start a hosted practice run on the same commit. It downloads the weights
   from the newest synced report for that commit before scoring.

## Share a local result

`cogworks sync` sends one saved report to your team on CogPortal. With no
path it sends the latest report:

```sh
cogworks sync
cogworks sync .cogbench/reports/<report>.json
```

The dashboard lists it under **LOCAL REPORTS**, marked
`SELF-REPORTED · NOT PROMOTABLE`, with your GitHub login, the commit, and the
result. It is your machine's claim, so it can never go on the leaderboard.
`sync` needs a linked device. It sends the metrics, diagnostics, commit, and
dirty flag, plus a copy of every weights file the run read, committed or not.
It never sends your source, other files, environment variables, predictions,
or logs.

`cogworks status` shows which portal this machine is linked to. To remove a
machine, revoke it from **Connections** on the website.

## Hosted runs and the leaderboard

Hosted runs start from the team dashboard, which resolves a branch to its
latest pushed commit and scores it on the course's machines. There are two
kinds:

- A **practice run** scores the public data, with logs you can read. A team
  has ten completed practice evaluations per benchmark version.
- **Promote to official** runs the same commit against hidden inputs, with
  logs suppressed. A team has three completed official evaluations per
  benchmark version, and only a succeeded practice run can be promoted.

A run that fails uses none of those, whether the fault was in your code or on
our side. A valid low score does count, because the evaluation completed.

The run page names what went wrong. If your code caused it, fix it, push,
and start a new practice run. **Retry** runs the same submission again, the
same commit with the same settings, so it helps only when the cause wasn't
in your code. The page leaves Retry out when a rerun can't work, for example
after the benchmark's configuration changed, and says why when it knows.

Publishing puts one official run on the public leaderboard for your team. It
costs nothing, and you can change which run it is as often as you like.

Week 1 song identification runs locally, but it has no hosted runs until the
course turns that benchmark on, and the dashboard doesn't list its synced
reports. Its test grid doesn't yet tell a good pipeline from a weak one, so a
hosted number would mislead.

## What a result is for

A run page leads with a sentence about what the run shows, such as where the
score falls off as the benchmark gets harder, and puts the number under it.
That's deliberate. The benchmark is an instrument for finding where your
pipeline breaks, and it isn't a grade. The portal doesn't score people; a
synced report names who synced it because it's that machine's claim.

## Discord

In the course server, `/cog` shows your team's state and links your Discord
account to CogPortal. If your team has bound a channel,
`cogworks run --live --benchmark <id>` still runs on your machine and keeps
one progress message updated in that channel. `--live` needs a linked device
and a committed GitHub repository.

## When something goes wrong

| What you see | What to do |
| --- | --- |
| `cogworks: command not found` | Activate the week's conda environment, then run the tool install line again. |
| `check` says a course package is missing and "The hosted run has the packages" | That gap is only on your machine. Install the week's CogWeb prerequisites to run locally. |
| `check` can't read a file, or can't find two functions that fit together | It names the file or the function it needs. Fix it, commit, and run `check` again. |
| `TypeError: 'type' object is not subscriptable` at import | The course environment is Python 3.8, and so are hosted Week 1 and Week 3 runs. Write `List[Tuple[...]]` from `typing` instead of `list[tuple[...]]`. |
| A command prints its local result, then a portal error | The local result is saved. Check your connection and `cogworks status`, then run the command again. |
| The "Done here?" command is refused | Copy a fresh one from the Setup page. |
| A hosted run failed | Read the failure on the run page. Fix and push if it was your code; otherwise use Retry. |

## Where your data goes

`check`, `test`, `run`, and `report` don't contact CogPortal unless you add
`--update-setup` or `--live`. `link`, `sync`, and `status` always do. Your
own code runs during these commands, and the benchmark may download public
data, so "local" means CogPortal isn't told, not that the machine stays
offline. No command uploads your source, arbitrary files, environment
variables, predictions, or logs.

## For platform developers

From this monorepo, install the SDK in editable mode instead:

```sh
python -m pip install -e python/cogbench
cogworks --version
```
