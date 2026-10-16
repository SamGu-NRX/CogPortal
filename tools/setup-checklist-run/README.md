# The setup checklist ticks from a real CLI

A Playwright walkthrough that runs the portal's setup sheet end to end: a student
signs in, starts their team on the fixture repository, then runs every command the
sheet shows — in a real shell, as the page instructs — while the page watches and
ticks the boxes live.

## What it walks

1. **Open.** Dev sign-in, join the seeded cohort (or resume an onboarded seat),
   start the team on `cogworks-demo/face-finder`, land on `/setup` at 1440x900 and
   390x844. The sheet reads **0 of 5 done · Watching for your terminal**.
2. **Clone.** `git clone https://github.com/cogworks-demo/face-finder.git`.
3. **Tool.** `python -m pip install --upgrade --force-reinstall cogworks-benchmark …`.
4. **Benchmark.** `python -m pip install cogworks-week2-vision-benchmark[data] …`.
5. **Link.** `cogworks link --portal <portal> --no-browser`; the driver approves
   the device in a second tab from `/connections`. The page ticks **clone + link**
   within one poll interval.
6. **Check.** `cogworks check --benchmark vision-recognition --update-setup`. The
   page ticks the rest — **5 of 5 done, all seen by the portal** — and the
   **Setup complete** card appears.

## Environment

- Portal dev stack: `pnpm dev` at `http://[::1]:5173` (Vite binds IPv6 localhost),
  `DEV_AUTH=enabled`, `EXECUTION_PROVIDER=fixture`, seeded local D1.
- Python: a venv with the pinned `cogworks-benchmark` and
  `cogworks-week2-vision-benchmark[data]` (CPU torch), on `PATH` ahead of the
  system interpreter, `PYTHONUNBUFFERED=1`.
- The fixture repository is served by a local bare clone staged at a path ending
  in `github.com/cogworks-demo/face-finder.git` with a scoped `insteadOf` rule, so
  `git clone` and `cogworks check --update-setup` reach real git transport while
  never leaving the machine.

## Run it

```sh
pnpm dev &            # apps/portal dev stack, seeded
export PORTAL="http://[::1]:5173"
node run.mjs          # writes evidence/ next to this file
```

Evidence lands in `evidence/`: `journey.json` (one entry per milestone with the
before/after row state), per-command CLI captures, the approval page text, and
screenshots at both widths.

## Notes

- The sheet follows the selected track (a browser view preference,
  `cogportal.track` in localStorage, defaulting to the course's last-active
  module). The driver pins `vision-recognition` after sign-in so the commands it
  runs and the boxes it watches are the same track's.
- Mobile captures at 390x844 are below the 720px shorter-edge QA minimum and are
  kept as artifacts in `evidence/`, not submitted as QA records.
