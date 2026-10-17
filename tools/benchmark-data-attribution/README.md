# Benchmark data attribution inventory

Answers, from **committed repository metadata only**: what data, models, and
mirrored material do the CogWorks benchmarks use, where is each pinned, and
what reuse notices exist?

The tool records evidence; it does not grant permission. Every statement is
observational (what a committed file says, quoted and hashed) and every
resource whose reuse is not established by committed metadata is recorded as
`evidenceState: "unknown"` — never guessed. URL reachability, when checked,
is evidence about the network, never about permission.

## Files

- `inventory.py` — generator. Reads committed metadata (the parent repo plus
  the pinned submodule checkouts) and refuses to run when the checkout's
  input files are not the committed bytes; builds the resource list, and
  validates output against the schema **before** writing it.
- `schema/resources.schema.json` — draft 2020-12 schema for the inventory.
- `validate.py` — dependency-free validator for exactly the keywords the
  schema uses.
- `reader.py` — offline reader. `summary`, `unknowns`, `resource <id>`.
  Refuses to display free text that asserts permission; verbatim license
  quotes are observational and always shown. Refuses url-checks recorded
  for a revision other than the inventory's own.
- `test_inventory.py` — pytest suite over a synthetic clone (no network).

## Usage

```sh
# The pinned benchmarks/week* submodules must be checked out first:
git submodule update --init

# Offline inventory for the working tree
python3 tools/benchmark-data-attribution/inventory.py --out /tmp/attr

# Against another checkout (used by the tests)
python3 tools/benchmark-data-attribution/inventory.py --out /tmp/attr --root /path/to/clone

# Bounded read-only reachability checks (≤12 URLs, recorded separately)
python3 tools/benchmark-data-attribution/inventory.py --out /tmp/attr --verify-urls

# Summaries
python3 tools/benchmark-data-attribution/reader.py /tmp/attr/resources.json summary
python3 tools/benchmark-data-attribution/reader.py /tmp/attr/resources.json unknowns
python3 tools/benchmark-data-attribution/reader.py /tmp/attr/resources.json resource week2-facenet-checkpoint

# Tests
python3 -m pytest tools/benchmark-data-attribution/test_inventory.py -q
```

Exit codes: `0` ok, `1` schema violation (nothing written), `2` missing
required committed inputs, `3` the checkout does not match the recorded
commits (uncommitted input edits, missing submodule checkouts, or submodule
HEADs off their pins).

## Evidence states

- `verified` — stated by committed repository metadata quoted in the inventory.
- `secondary` — a committed pointer to terms held elsewhere (the terms are
  not reproduced in this repository).
- `unknown` — no committed notice was found. Recorded, not guessed.

## Generated evidence

The inventory for a given checkout is written to a scratch directory and, at
review time, its committed copy lives under `docs/attribution/`:

- `resources.json` — the full inventory document.
- `summary.json` — per-source-group counts.
- `summary.md` — human-readable summary with unresolved terms.
- `url-checks.json` — reachability results (only when run with
  `--verify-urls`); kept separate from reuse evidence by design.

Rebuild any of it for the same `baseRevision` and the output is
byte-identical (the suite proves this by replaying `main()` over two
identical synthetic clones).
