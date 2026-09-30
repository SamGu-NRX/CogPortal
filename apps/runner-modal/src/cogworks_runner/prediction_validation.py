"""Controller-side validation of the predictions read back from the sandbox.

The sandbox already counts its own outputs against the case list
(`EVALUATE_SCRIPT` in modal_app, the four `len(predictions) != len(...)` raises). That check
runs inside the student's own process, before the file is written, so it is
advice rather than a guarantee: a module-level atexit handler that rewrites
/tmp/cog-predictions.json runs after the script's final write, and the file
the controller reads is then whatever the handler put there. The same is true
of the 8 MiB cap on the line above that write. Everything the controller is
unwilling to be wrong about has to be re-checked here, on this side of the
boundary.

What a missed check costs, measured against the real scoring modules:

  * A short output list is not a crash. `zip(cases, outputs)` truncates, so
    four Week 1 outputs covering a submission's two correct queries score
    `identification_score` 1.0 where the honest twelve score 0.2, and one
    perfect Week 2 clustering scenario out of four scores
    `clustering_pairwise_f1` 1.0 against 0.54 (both re-measured against
    `ClusteringBenchmark.score`, which zips before `score_clustering` sees a
    length to compare).
  * A wrong element type is an uncaught AttributeError inside `score()`, and
    `modal_app.execute_job` classifies any non-RunnerFailure raised during the scoring
    phase as `scorer` with `infrastructure=True`. That copy tells the team
    "this is a platform problem, not a problem with your code". Validate
    malformed submission output before scoring so that advice stays accurate.

`output_invalid` already has the appropriate copy in contracts/failures.ts.
Every failed execution releases capacity; this boundary determines ownership
of the failure, not whether an evaluation counts against quota.
"""

from __future__ import annotations

import json
from typing import Any, Dict, List, Optional, Tuple

from .failure import RunnerFailure


class _NonFiniteNumber(ValueError):
    """A NaN or an infinity was found while parsing the predictions file."""


def _reject_constant(name: str) -> float:
    raise _NonFiniteNumber(name)


def _finite_float(text: str) -> float:
    value = float(text)
    # `value - value` is 0.0 for every real number, NaN for a NaN (which never
    # equals itself) and NaN for either infinity. One subtraction therefore
    # covers all three without importing math into the hottest loop of the
    # parse. Measured indistinguishable from math.isfinite on a 17 MB payload.
    if value - value != 0.0:
        raise _NonFiniteNumber(text)
    return value


#: Above this, `_bounded_int` stops trusting the value to float() and checks.
#: 2**63 is not a limit Python has; it is just comfortably past any count,
#: index, or score a benchmark deals in, and well under the float ceiling.
_SAFE_INT = 2 ** 63


def _bounded_int(text: str) -> int:
    """An integer the scoring code can still turn into a float.

    Scoring calls float() on submission numbers in several places (Week 1's
    `_margin`, `_v2_metrics`' own `float(value)`), and `float(2 ** 1024)`
    raises OverflowError rather than returning an infinity. Uncaught during
    scoring that is the `scorer`/infrastructure path, which misattributes a
    400-digit integer supplied by the submission to our scorer.

    Tried by conversion rather than by a bit-length bound. The bound is not
    exactly on a bit boundary: 2**1023 has 1024 bits and converts, 2**1024 - 1
    also has 1024 bits and overflows, because the conversion rounds before it
    range-checks. Asking float() is both shorter and right at the edge.
    """

    value = int(text)
    # Cheap pre-filter. Every int a submission has any business returning is
    # far below this, and it keeps the try out of the common path.
    if -_SAFE_INT <= value <= _SAFE_INT:
        return value
    try:
        float(value)
    except OverflowError as error:
        raise _NonFiniteNumber(text[:32]) from error
    return value


#: Plain words for the types a JSON document can hold. A team reading this is
#: looking at their own Python, so the words are Python's, except that
#: "NoneType" is the interpreter's vocabulary rather than anything they wrote.
_TYPE_WORDS = {
    dict: "a dictionary",
    list: "a list",
    str: "a string",
    bool: "a true/false value",
    int: "a number",
    float: "a number",
    type(None): "None",
}


def _type_word(value: Any) -> str:
    return _TYPE_WORDS.get(type(value), type(value).__name__)


def load_predictions(raw: str) -> List[Any]:
    """Parse the predictions file, refusing non-finite numbers at parse time.

    `json.loads` accepts the non-standard tokens NaN, Infinity and -Infinity by
    default, and `json.dumps` re-emits them. A NaN that survives to a metric
    reaches the completed event body, where `JSON.parse` in the Worker rejects
    the literal `NaN` and returns 400 from runner-events.ts. The run is scored,
    the event is dropped, and the run never reaches a terminal state, which
    reads to a team as a hung run rather than as a refusal.

    The hooks catch this during the parse instead of walking the parsed
    structure afterwards. A walk is a second full traversal (measured 0.043 s
    against 0.047 s for the parse itself on a 9 MB payload, so roughly double
    the cost), it has to recurse or maintain its own stack over student-shaped
    data, and it cannot see 1e400, which parses to `inf` with no NaN token
    anywhere in the file. `parse_float` catches that overflow because it sees
    the text. Measured overhead of the three hooks together: `parse_constant`
    is free, `parse_float` costs 35 percent of parse time on a float-heavy
    payload, `parse_int` 2.4x on an int-heavy one, all of it on a parse that
    runs once per run and takes tens of milliseconds.
    """

    try:
        parsed = json.loads(
            raw,
            parse_constant=_reject_constant,
            parse_float=_finite_float,
            parse_int=_bounded_int,
        )
    except _NonFiniteNumber as error:
        raise RunnerFailure(
            "output_invalid",
            "evaluating",
            # Kept under the 240 characters execute_job truncates `detail` to,
            # since a refusal cut mid-sentence loses the half that helps.
            "Your results hold the value {}, which is not a finite number. A "
            "NaN or an infinity here usually comes from a division by zero or "
            "an average over an empty list. Check the numbers your adapter "
            "returns.".format(str(error)[:40]),
            False,
        ) from error

    # The top-level value has to be a JSON array. Each evaluate lane calls
    # list() on what it returns, and list() is a coercion rather than a check:
    # a top-level object becomes a list of its keys, so {"a": 1, "b": 2} turns
    # into ['a', 'b'] and arrives at the count check looking like two results.
    # A top-level string spreads into its characters the same way. Refusing
    # here means the count check downstream counts results rather than
    # whatever list() happened to manufacture.
    if type(parsed) is not list:
        raise RunnerFailure(
            "output_invalid",
            "evaluating",
            "Your submission's results came back as {}, and scoring reads a "
            "list holding one result per case. Check what your adapter "
            "returns.".format(_type_word(parsed)),
            False,
        )
    return parsed


#: What one element of the predictions list has to be, per benchmark: the
#: element's own type, the fields inside it that scoring will iterate, and the
#: types its items may have when the element is itself a list of labels.
#:
#: Three different element types live in this table because the three weeks
#: really do differ. Weeks 1 and 3 call `output.get(...)` on every element,
#: Week 2 recognition reads a Mapping of lifecycle labels, and Week 2
#: clustering reads a flat list holding one label per image. The field names
#: come from the drivers that build these outputs (`drivers.py` in each
#: benchmark package), not from a guess about what scoring might want.
#:
#: Keyed by benchmark_id and consulted only for `cogworks.submissions.v2`,
#: because "vision-recognition" is also the id of the v1 fixture benchmark,
#: whose score() str()-coerces whatever it is handed and so constrains nothing
#: beyond the count.
#:
#: A v2 benchmark missing from this table still gets the count check. That is
#: the deliberate failure mode for a week added later: the check that stops
#: score inflation keeps working, and no submission is refused for a shape
#: nobody has written down yet. `test_prediction_validation.py` fails when a
#: registered v2 benchmark has no entry, so the omission surfaces in CI rather
#: than in a run.
_V2_PREDICTION_SHAPES: Dict[str, Tuple[type, Tuple[str, ...], Optional[Tuple[type, ...]]]] = {
    "audio-identification": (dict, ("candidates", "scores", "mappings"), None),
    "language-search": (
        dict,
        ("embeddings", "text", "images", "rankings", "mappings"),
        None,
    ),
    "vision-recognition": (dict, ("known", "unknown_before", "post_enrollment"), None),
    # Cluster labels are dict keys twice over in scoring: `Counter(zip(...))`
    # and `Counter(actual)` in adjusted_rand_index. A list or dict label is an
    # uncaught TypeError there, so the item types are checked and not left to
    # the driver, which validated them inside the sandbox.
    "vision-clustering": (list, (), (str, int)),
}

#: The one field above that is legitimately null. The Week 1 driver writes
#: `"scores": None` when the submission returned candidates without them, and
#: `_margin` reads that None and returns None. A null in any other field is a
#: crash inside score().
_NULLABLE_PREDICTION_FIELDS = frozenset({"scores"})

#: Fields whose contents are handed to numpy as a float or int matrix, and the
#: leaf type each one's numbers have to be.
#:
#: The field check above stops one level down: it asks whether the value is a
#: list and never asks what is inside. That is not enough for these fields,
#: because `null` is the one wrong value that neither parse hook can see.
#: `parse_constant` fires on the tokens NaN, Infinity and -Infinity;
#: `parse_float` and `parse_int` see number text. A JSON `null` is none of
#: those, so it parses to Python None, and `np.asarray([[None]], dtype=float)`
#: turns None into NaN without raising. The same is true of the strings "nan"
#: and "inf", which float() accepts.
#:
#: NaN does not merely produce a wrong number, it produces the best possible
#: one. Measured against `component_scores` with the public-evaluation text
#: block (500 captions, two per image): an honest random submission scores
#: text_mrr 0.0101, and one whose embeddings are every-value-null scores
#: 1.0000, with `overall` going 0.0034 to 0.3333. The mechanism is that
#: `text_first_relevant_ranks` excludes a caption from its own results by
#: writing -inf on the score matrix diagonal, then sorts by -score. With an
#: all-NaN matrix the diagonal is the only non-NaN entry, and numpy sorts NaN
#: after every real value including +inf, so each caption ranks itself first
#: and every co-caption lands at rank 1. The exclusion that makes the metric
#: meaningful is what the NaN defeats.
#:
#: Week 3's own `coerce_matrix` rejects non-finite values already, and this is
#: not a second opinion on it: that check runs inside the sandbox, in the
#: student's process, on the way out. This side re-checks what reaches numpy.
#:
#: Cost of the walk, measured on a 6.23 MiB public-evaluation-shaped payload
#: with 698,700 numeric leaves: 0.012 s, against 0.034 s for the parse it
#: follows. It is a leaf scan and not a recursion because every field here is
#: exactly two levels deep, a list of rows of numbers.
_NUMERIC_MATRIX_FIELDS: Dict[str, Tuple[type, ...]] = {
    # np.asarray(..., dtype=float). bool is accepted at the leaf check itself
    # rather than listed here, because `type(True) is bool` and a bare
    # membership test would refuse it. See `_check_matrix_field` for why it is
    # allowed through.
    "embeddings": (int, float),
    "text": (int, float),
    "images": (int, float),
    # int(image_id) in search_ranks. A float id is accepted there (int(3.7) is
    # 3) and a str id is accepted when it spells a number, so both are left
    # alone; None and every other type raise inside scoring.
    "rankings": (int, float, str),
}

#: Fields whose rows are allowed to be ragged and allowed to be empty, so the
#: rectangle check is skipped for them.
#:
#: "rankings" is the only one. Each query returns up to k ids and fewer when
#: the submission's index held fewer, and `validate_rankings` writes [] for a
#: query that matched nothing; `search_ranks` scores a short or empty row as a
#: miss on purpose. The embedding fields are not in this set, because they are
#: handed to numpy as a matrix: a ragged one raises ValueError during scoring,
#: and a zero-width one scored text_mrr 0.6667 on a 4-caption case where
#: honest work scored less, since an empty row makes every pair tie.
_EMPTY_ROW_OK = frozenset({"rankings"})


def _refuse_output(detail: str) -> RunnerFailure:
    """Build the refusal for results that cannot be scored.

    `infrastructure=False` and `output_invalid` identify malformed submission
    results, rather than blaming the platform's scorer. Every failure releases
    capacity; attribution still determines which problem the team is told about.

    The phase is "evaluating" rather than "scoring". What is wrong is the
    submission's results, and those were produced during evaluation; naming
    the scoring phase would put our own name on a step that never ran.
    """

    return RunnerFailure("output_invalid", "evaluating", detail, False)


def _check_matrix_field(index: int, field: str, rows: List[Any]) -> None:
    """Refuse a numbers-field whose leaves are not numbers.

    See `_NUMERIC_MATRIX_FIELDS` for why this exists and what it costs: JSON
    `null` reaches numpy as NaN, and a NaN embedding scores 1.0 rather than
    crashing. Ragged rows are refused too, since numpy raises on them and an
    uncaught raise during scoring would incorrectly blame the platform.

    Only the first offending leaf is named. A submission that got this wrong
    usually got it wrong everywhere, and one location is what the team needs
    to find the line.
    """

    leaf_types = _NUMERIC_MATRIX_FIELDS[field]
    rectangular = field not in _EMPTY_ROW_OK
    width: Optional[int] = None
    for position, row in enumerate(rows):
        if type(row) is not list:
            raise _refuse_output(
                'In result {}, row {} of "{}" came back as {}. Each row holds '
                "one list of numbers.".format(index, position, field, _type_word(row))
            )
        # "rankings" is skipped here and only here: it is legitimately ragged
        # and legitimately empty, because each query returns up to k ids and
        # `validate_rankings` writes [] for a query that matched nothing.
        # `search_ranks` scores a short or empty row as a miss on purpose. The
        # embedding fields are a matrix and get both checks.
        if rectangular:
            if not row:
                raise _refuse_output(
                    'In result {}, row {} of "{}" is empty, and scoring reads '
                    "one number per position.".format(index, position, field)
                )
            if width is None:
                width = len(row)
            elif len(row) != width:
                # numpy raises ValueError on a ragged nested list, and an
                # uncaught raise once the phase is "scoring" is reported as
                # our fault rather than the submission's.
                raise _refuse_output(
                    'In result {}, "{}" has rows of different lengths ({} and '
                    "{}). Every row needs the same number of values.".format(
                        index, field, width, len(row)
                    )
                )
        for column, item in enumerate(row):
            # bool is checked first because `type(True) is bool`, not int, and
            # numpy reads True as 1.0. A submission whose embeddings are all
            # True scores text_mrr 0.1620 against the 0.1624 chance floor,
            # which is an honest bad score rather than an inflated one, so
            # refusing it would cost a team an attempt for nothing.
            if type(item) is bool or type(item) in leaf_types:
                continue
            raise _refuse_output(
                'In result {}, "{}" holds {} at row {}, position {}, where '
                "scoring reads a number. A null here becomes a NaN and cannot "
                "be scored.".format(index, field, _type_word(item), position, column)
            )


def check_predictions(benchmark: Any, predictions: List[Any], case_count: int) -> None:
    """Refuse results that score() cannot read, before score() sees them.

    Called once, from execute_job, on the path all four evaluate lanes
    converge to. One call site rather than four is the point: a fifth lane
    added later is covered by construction instead of by remembering.

    Shallow wherever score() already defends itself, and it is left alone
    there: `score_recognition` returns `_empty_recognition_score()` for every
    length mismatch it can see, and `score_clustering` zeros a case whose
    label count is wrong. A second opinion on either would mean two places to
    edit when the contract moves.

    The exception is `_NUMERIC_MATRIX_FIELDS`, where the check goes down to
    the leaves. Those fields are handed to numpy, and numpy turns a JSON
    `null` into NaN rather than raising, which scores 1.0 instead of failing.
    Week 3's own `coerce_matrix` and `validate_rankings` do reject that, but
    both run inside the sandbox in the student's own process, and this whole
    module exists because that side is not trusted.
    """

    if len(predictions) != case_count:
        # This check covers both student-built v1 lists and driver-built v2 lists.
        raise _refuse_output(
            "Scoring received {} results for {} cases and needs one per case. "
            "If your adapter builds this list, check its length. Otherwise, "
            "tell course staff.".format(len(predictions), case_count)
        )

    if getattr(benchmark, "contract_version", None) != "cogworks.submissions.v2":
        return
    shape = _V2_PREDICTION_SHAPES.get(getattr(benchmark, "benchmark_id", ""))
    if shape is None:
        return
    element_type, fields, item_types = shape

    for index, element in enumerate(predictions):
        # Exact type, not isinstance. json.loads produces a dict for an object
        # and a list for an array, so nothing legitimate is excluded, and a
        # string passes every Sequence check while scoring iterates it one
        # character at a time. Measured: a two-character string in Week 2's
        # "known" field clears the length guard and scores as two correct
        # labels, and a four-character clustering element clears both length
        # guards and is scored as a partition.
        if type(element) is not element_type:
            raise _refuse_output(
                "Result {} came back as {}, and this benchmark scores {} for "
                "each case. Check what your adapter returns for that "
                "case.".format(index, _type_word(element), _TYPE_WORDS[element_type])
            )
        if item_types is not None:
            for position, item in enumerate(element):
                # isinstance and not type(), so a bool label passes here. The
                # driver refuses bools inside the sandbox as a contract
                # matter, but scoring treats True as 1 and False as 0 and
                # returns a correct partition for them (measured: identical
                # metrics to the same labels written as 1 and 0). Refusing a
                # payload that scores correctly would cost a team an attempt
                # for nothing.
                if not isinstance(item, item_types):
                    raise _refuse_output(
                        "In result {}, label {} came back as {}. Cluster "
                        "labels have to be strings or numbers; only which "
                        "labels match each other matters, never what they are "
                        "called.".format(index, position, _type_word(item))
                    )
            continue
        for field in fields:
            if field not in element:
                # Absent is normal and is not an error. A failed case writes
                # {"ok": False, "error": ...} with none of these fields, and
                # scoring reads that shape on purpose.
                continue
            value = element[field]
            if type(value) is list:
                if field in _NUMERIC_MATRIX_FIELDS:
                    _check_matrix_field(index, field, value)
                continue
            if value is None and field in _NULLABLE_PREDICTION_FIELDS:
                continue
            raise _refuse_output(
                'In result {}, "{}" came back as {} where scoring reads a '
                "list. Check what your adapter puts in that "
                "field.".format(index, field, _type_word(value))
            )


#: The two keys a shuffled recognition scenario comes back under. These are
#: what the sandbox writes, so these are what gets checked; the lifecycle keys
#: score() reads do not exist yet at this point.
_RECOGNITION_BATCHES = ("before_enrollment", "after_enrollment")


def restore_v2_predictions(predictions: List[Any], plans: List[Any]) -> List[Any]:
    """Put shuffled recognition predictions back into the shape score() reads.

    Clustering carries no plans and passes straight through.

    This is also where a recognition scenario's shape is checked, and it has
    to be here rather than in `check_predictions`. The two functions run in
    this order (restore at the call in `_evaluate_v2`, then the check from
    `execute_job`) because the check reads the lifecycle field names "known",
    "unknown_before" and "post_enrollment", and those only exist once the
    shuffle is undone. That ordering has a consequence worth stating plainly:
    `restore_recognition_outputs` ends in a literal dict of three list slices,
    so by the time `check_predictions` sees a recognition result, the result
    is a dict-of-lists no matter what the sandbox wrote. Its table entry for
    "vision-recognition" is a backstop for the path where no plans exist, not
    the live check. The live check is the one below, on the shape that
    actually exists here.

    What it stops: `restore_recognition_outputs` reads its batches through
    `list(output.get(...))`, and list() coerces rather than checks. Measured
    against a 3-before / 1-after plan, `{"before_enrollment": "abc",
    "after_enrollment": "d"}` restored to `{"known": ["a", "c"],
    "unknown_before": ["b"], "post_enrollment": ["d"]}`, cleared the length
    guard because len("abc") is 3, and arrived at `check_predictions` as a
    clean dict of lists. A dict batch of the right size behaves the same way,
    since iterating a dict yields its keys.

    The refusals here are `output_invalid` rather than provider faults, for the
    reason `_refuse_output` states: what is wrong is the submission's results,
    and a provider category would misidentify their cause. The sandbox driver
    already length-checked each batch before writing the file, but that check
    ran inside the student's own process, so it is re-done on this side.
    """

    # Imported here because week2_payload loads NumPy, which the runner package
    # does not declare, and a local `modal deploy` imports this module.
    from cogworks_runner.week2_payload import restore_recognition_outputs

    if not plans:
        return predictions
    if len(predictions) != len(plans):
        # Left to `check_predictions`, which owns the count check and words it
        # for the reader. Returning early keeps one message for one fault.
        return predictions
    restored: List[Any] = []
    for index, (output, plan) in enumerate(zip(predictions, plans)):
        if not isinstance(output, dict):
            raise _refuse_output(
                "Each recognition scenario has to return a mapping of labels, "
                "and one came back as {}.".format(_type_word(output))
            )
        for batch in _RECOGNITION_BATCHES:
            if batch not in output:
                # Absent is left to the length guard inside
                # `restore_recognition_outputs`, which reports it as a count
                # and words it better than a missing-key message would.
                continue
            if type(output[batch]) is not list:
                raise _refuse_output(
                    'In result {}, "{}" came back as {}, and recognize returns '
                    "one label per image. Check what your adapter returns for "
                    "that batch.".format(index, batch, _type_word(output[batch]))
                )
        try:
            restored.append(restore_recognition_outputs(plan, output))
        except (ValueError, TypeError) as error:
            raise _refuse_output(str(error)[:240]) from error
    return restored
