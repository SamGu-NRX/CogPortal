# Student code starts in a fresh interpreter, not a fork

**Status:** decided 2026-09-10, from a measured crash rather than a general
worry about fork safety.

## What failed

`cogbench` ran student code by forking. On macOS the child aborted before it
reached the benchmark. The trigger measured here was `_scproxy._get_proxy_settings`,
the proxy lookup Python performs on the first outbound request: it calls a
high-level system framework, and calling one of those after `fork` without
`exec` raises `SIGABRT`.

Python [documents this](https://docs.python.org/3.11/library/os.html#os.fork).
It is not specific to the proxy call. Any macOS framework that was holding a
lock, or had registered state with the parent, is entitled to abort in a forked
child, and the abort arrives before student code gets a chance to report
anything.

Warming the proxy lookup in the parent does stop that one crash, and it was
tempting because it is a two-line change. It was rejected because it fixes one
call. This tool exists to run arbitrary scientific libraries chosen by
seventeen-year-olds; the next one to touch a framework in a forked child would
fail the same way, and the failure would look to a student like their code
crashing for no reason.

## What we do instead

`run_operation` starts a new interpreter with `subprocess.Popen` and hands it a
JSON request file. Because the child is a real `exec`, no framework state is
inherited and the class of failure above cannot occur.

The child is bounded before it runs a line of student code: resource limits,
`cwd` set to a scratch directory, `start_new_session=True` so descendants can be
cleaned up as a group, and `PYTHONHASHSEED="0"` so a run is reproducible. The
result comes back over a pipe passed by `pass_fds`.

## Only named operations cross the boundary

The request names one of three operations, `check`, `run`, or `survey`, and
carries the benchmark and repository it applies to. The child reconstructs the
work from those names.

Nothing else crosses. The obvious alternative was to serialize the callable the
parent already had, which is what a general worker service would do, and it was
rejected twice over: it turns every future caller into a serialization problem,
and it is the design that made the old boundary depend on `pickle`. Three named
operations cover every path that can reach student code, so the parent never
needs to ship behavior.

## This removed the pickle premise rather than deferring it

The previous boundary sent results back as a pickle, which meant bytes chosen by
student code were decoded into objects in the parent. That objection had been
open across several phases.

It is gone, and not because it was fixed separately. Once only named operations
cross, the result is data rather than a reconstructed object, so JSON is
sufficient. `isolate.py` no longer imports `pickle`.

JSON stops child bytes from becoming code in the parent. It does not stop a
child lying about its result, which is a separate problem with a separate
defense.

## What it costs

An `exec` is slower than a `fork`, and the child re-imports the benchmark
instead of inheriting it. That is paid once per operation, against runs that
take seconds to minutes, so it does not show up next to the work itself. It is a
real cost on `check`, which is otherwise fast.

The parent can no longer read the child's memory to find out what happened. Every
outcome now has to be stated explicitly and carried over the pipe or inferred
from how the process died, which is why the outcome reporting is more elaborate
than it was.
