## apploader.py

`cogbench.apploader` loads a student submission by importing one file, chosen
by path, from the student's repository. Entry-point discovery only works for
installed packages, and the thirteen audited student repositories carry no
packaging at all: none of them has a `pyproject.toml` or a `setup.py`
(attested in `docs/design/week1-benchmark-plan.md` and
`docs/pitch/beaver-works.md`).

The file-path approach is a security decision, not just a convenience. The
alternative, running `pip install -e` on student code, executes a `setup.py`
inside the prepare sandbox while it still has network access. Importing one
file by path keeps every line of student code behind the hosted runner's
network block. The module also never calls the factory it finds; it returns
the callable, and the caller decides when student code runs.

### Which file, which factory

The loader looks only at the repository root, in this order
(`CANDIDATE_FILENAMES`):

1. `submission.py`, the name the course documents.
2. `benchmark_adapter.py`, which the two reference repositories in
   `examples/` (the Week 3 example) and
   `benchmarks/week2/face_recognition_app` already use.

The first file that exists wins, so a repository with both files is scored on
`submission.py`.

Factory names come from `factory_names(contract_name)`, in resolution order:

1. `create_submission`, always first; it's the contract-independent name new
   repositories should use.
2. `create_<contract>_adapter`, with the contract's non-alphanumeric
   characters turned to underscores, so `vision-recognition` looks for
   `create_vision_recognition_adapter`.
3. `create_<last-word>_adapter`, built from the contract's final word, so
   `vision-recognition` also looks for `create_recognition_adapter`. The
   shipped entry points use this shorter form (`language-search` maps to
   `create_search_adapter`).

The contract-shaped names exist because one module can serve several
contracts; `face_recognition_app` defines both `create_recognition_adapter`
and `create_clustering_adapter` in one module. If no callable matched, a
class named `Submission` is accepted as a last resort, and the caller
instantiates it for v1 contracts.

### When resolution fails

`resolve_submission_file` raises one of three exceptions under
`SubmissionFileError`, and each message names the file and one next action:

- `SubmissionFileMissing`: neither candidate file exists at the repository
  root. Next action: create `submission.py` there, define
  `create_submission`, and return the adapter from it.
- `SubmissionImportFailed`: the file raised while it was being imported. The
  error carries the deepest traceback line inside the student's repository,
  so the message points at the student's line, not at `importlib`. A stray
  `exit()` at import time is caught the same way and becomes this error
  instead of a quiet dead process.
- `SubmissionFactoryMissing`: the file imported cleanly but defines none of
  the expected names. The message lists everything it looked for, including
  `Submission`.

`resolve_submission_file` returns a `SubmissionSource`, which holds the file
path, the attribute name, and the factory itself. Its `describe()` produces
the `submission.py:create_submission` string that `cogworks check` prints as
`submissionDetail`. `load_submission_file` is the one-call form that returns
just the factory.

One side effect is deliberate: the loader puts the repository root at the
front of `sys.path` and leaves it there, because the adapter file often
imports the student's own modules lazily, inside the factory, long after the
loader has returned.
