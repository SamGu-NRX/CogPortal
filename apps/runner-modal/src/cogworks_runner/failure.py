"""The one exception type every controller stage raises for a categorized failure.

It lives outside modal_app so prediction_validation can raise it without
importing Modal. There must be exactly one class object: `execute_job` checks
`isinstance(error, RunnerFailure)` to keep a failure's own category, and
reports anything else as a platform fault.
"""

from __future__ import annotations

from typing import Any, Dict, Optional


class RunnerFailure(RuntimeError):
    def __init__(
        self,
        category: str,
        phase: str,
        detail: str,
        infrastructure: bool,
        refusal: Optional[Dict[str, Any]] = None,
        log: Optional[str] = None,
    ):
        super().__init__(detail)
        self.category = category
        self.phase = phase
        self.infrastructure = infrastructure
        #: Why nothing could be found to score, when that is what failed.
        #: `detail` is one capped line, which is right for a log and too short
        #: for the thing a student acts on: a refusal names the step that
        #: stalled, the shape their last function returned, the modules that
        #: could not be read, and the one next thing to do.
        self.refusal = refusal
        #: What the evaluation printed before it stopped, traceback last, when
        #: the sandbox got far enough to write it. Display only: `execute_job`
        #: sends it for practice runs exactly as it sends a completed run's
        #: log, and nothing reads it to decide the category.
        self.log = log
