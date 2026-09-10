"""Round trips keep the renderer's dataclasses aligned with their JSON records."""
import json
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))
from cogbench import cli, isolate
from cogbench.isolate import COMPLETED, Outcome
from cogbench.raised import Raised
from cogbench.resolve import Attempt, SubmissionReport
from cogbench.verdict import Coverage, Observation, Verdict


class ReportRoundTrips(unittest.TestCase):
    def roundtrip(self, value):
        encoded = json.loads(json.dumps(value.to_dict()))
        self.assertEqual(type(value).from_dict(encoded), value)

    def verdict(self):
        return Verdict(
            'not_wired', 'Could not connect the query.',
            trace=(Observation('features', 'train.features', 'one image', 'a vector'),),
            next_step='Check the query input.', notes=('A note with λ.',),
            coverage=Coverage(('train',), (('helper', 'missing package', 'ours'),)),
            errors=(Raised('train.py', 24, 'train.prep_data', 'ValueError: wrong shape'),),
        )

    def test_observation(self):
        self.roundtrip(Observation('features', 'train.features', 'image', 'vector'))

    def test_coverage(self):
        self.roundtrip(Coverage())
        self.roundtrip(self.verdict().coverage)

    def test_raised(self):
        self.roundtrip(Raised('train.py', 0, 'train.prep_data', 'ValueError: bad shape'))

    def test_verdict(self):
        self.roundtrip(Verdict('nothing_here', 'No code found.'))
        self.roundtrip(self.verdict())

    def test_attempt(self):
        self.roundtrip(Attempt('train.store', 'train.query', 2))

    def test_submission_report(self):
        self.roundtrip(SubmissionReport(False, self.verdict()))
        self.roundtrip(SubmissionReport(True, self.verdict(), ('train.features',),
                                       Attempt('train.store', 'train.query', 2),
                                       {'nested': {'array': [True, None, 'λ']}}))

    def test_windows_fork_and_exec_use_the_same_rehydration(self):
        report = SubmissionReport(False, self.verdict(), ('train.features',))
        # Every key `_check` reads: the boundary rejects a partial view now,
        # so a stub that was not one never exercised rehydration.
        view = {
            'report': report.to_dict(), 'survey': {'modules': []},
            'ready': False, 'source': None, 'declaredDetail': None,
            'declaredSource': None, 'declaredError': None,
            'discoveryUnavailable': None,
        }
        for backend in ('inline', 'fork', 'exec'):
            with self.subTest(backend=backend), \
                 patch.object(cli, '_check_view', return_value=view), \
                 patch.object(isolate, 'run_isolated', return_value=Outcome(COMPLETED, value=view)) as fork, \
                 patch.object(isolate, 'run_operation', return_value=Outcome(COMPLETED, value=view)) as execute, \
                 patch.object(isolate, '_isolation_backend', return_value={
                     'inline': None, 'fork': fork, 'exec': execute}[backend]):
                actual, status, detail = cli._read_repository('fixture', Path('/tmp'), True)
            self.assertEqual(status, COMPLETED, detail)
            self.assertEqual(actual['report'], report)
            self.assertEqual(actual['survey'], view['survey'])
            self.assertIsInstance(view['report'], dict)

    def test_invalid_check_report_keeps_status_and_diagnostics_consistent(self):
        for backend in ('inline', 'fork', 'exec'):
            with self.subTest(backend=backend), \
                 patch.object(cli, '_check_view', return_value={'report': {}}), \
                 patch.object(isolate, 'run_isolated', return_value=Outcome(COMPLETED, value={'report': {}})) as fork, \
                 patch.object(isolate, 'run_operation', return_value=Outcome(COMPLETED, value={'report': {}})) as execute, \
                 patch.object(isolate, '_isolation_backend', return_value={
                     'inline': None, 'fork': fork, 'exec': execute}[backend]):
                diagnostics = {}
                view, status, detail = cli._read_repository('fixture', Path('/tmp'), True,
                                                           diagnostics=diagnostics)
            self.assertIsNone(view)
            self.assertEqual(status, 'crashed')
            self.assertEqual(diagnostics['status'], status)
            self.assertIn('invalid check report', detail)

    def test_current_run_flags_are_json_serializable(self):
        for flags in ([], ['--json', '--update-setup', '--live', '--portal', 'https://fixture.invalid']):
            with self.subTest(flags=flags):
                args = cli._parser().parse_args(['run', '--benchmark', 'fixture'] + flags)
                self.assertEqual(json.loads(json.dumps(vars(args), allow_nan=False)), vars(args))

    def test_run_discovery_reuses_the_child_local_spec(self):
        spec = object()
        submission = SimpleNamespace(discovery=None)
        with patch.object(cli, 'load_benchmark', side_effect=AssertionError('spec rebuilt')), \
             patch.object(cli, 'from_spec', return_value=submission) as resolve:
            result, survey, unavailable = cli._discover('fixture', Path('/tmp'), True, spec=spec)
        self.assertIs(result, submission)
        self.assertIsNone(unavailable)
        self.assertIs(resolve.call_args[0][1], spec)


class AMalformedOperationResultIsCategorizedNotRaised(unittest.TestCase):
    """The envelope says the child finished. It says nothing about the shape.

    A `completed` payload whose value is None, `"{}"` or `"[]"` used to reach
    `LocalReport.from_json` and `_check`'s indexing, and raise TypeError or
    KeyError in the parent, which is the one place this boundary exists to
    keep failures out of. Each is now a categorized failure with a detail.
    """

    def _completed(self, value):
        return isolate.Outcome(isolate.COMPLETED, value=value, detail='')

    def test_a_check_view_missing_the_keys_check_reads_is_a_crash(self):
        for value in (None, '{}', [], {}, {'report': None}):
            with self.subTest(value=repr(value)[:24]), \
                    patch.object(cli.isolate, '_isolation_backend',
                                 side_effect=lambda: cli.isolate.run_operation), \
                    patch.object(cli.isolate, 'run_operation',
                                 return_value=self._completed(value)):
                view, status, detail = cli._read_repository('fixture', Path('/tmp'), True)
            self.assertIsNone(view)
            self.assertEqual(status, isolate.CRASHED)
            self.assertIn('invalid check report', detail)

    def test_a_complete_check_view_is_still_accepted(self):
        complete = {
            'report': None, 'survey': None, 'ready': False, 'source': None,
            'declaredDetail': None, 'declaredSource': None, 'declaredError': None,
            'discoveryUnavailable': None,
        }
        with patch.object(cli.isolate, '_isolation_backend',
                          side_effect=lambda: cli.isolate.run_operation), \
                patch.object(cli.isolate, 'run_operation',
                             return_value=self._completed(complete)):
            view, status, detail = cli._read_repository('fixture', Path('/tmp'), True)
        self.assertEqual(status, isolate.COMPLETED)
        self.assertEqual(view['ready'], False)

    def test_the_required_keys_are_the_ones_check_view_builds(self):
        """The tuple is a second statement of `_check_view`'s own shape.

        Nothing tied them together, so a key renamed in one place would make
        every real view invalid and only this test would say why.
        """

        empty = SimpleNamespace(
            factory=None, source=None, submission=None, survey=None,
            declared_source=None, declared_detail=None, declared_error=None,
            discovery_unavailable=None,
        )
        with patch.object(cli, 'load_benchmark', return_value=object()), \
                patch.object(cli, '_scoreable', return_value=empty):
            built = cli._check_view('fixture', Path('/tmp'), True)
        self.assertEqual(
            sorted(cli._CHECK_VIEW_KEYS), sorted(built),
            'the contract and the view it describes have drifted',
        )

    def test_a_check_view_whose_survey_is_not_an_object_is_a_crash(self):
        # `render_survey` indexes it, so key presence is not the whole shape.
        complete = {key: None for key in cli._CHECK_VIEW_KEYS}
        for survey in (['invalid'], 'text', 3):
            with self.subTest(survey=repr(survey)), \
                    patch.object(cli.isolate, '_isolation_backend',
                                 side_effect=lambda: cli.isolate.run_operation), \
                    patch.object(cli.isolate, 'run_operation',
                                 return_value=self._completed(dict(complete, survey=survey))):
                view, status, detail = cli._read_repository('fixture', Path('/tmp'), True)
            self.assertIsNone(view)
            self.assertEqual(status, isolate.CRASHED)
            self.assertIn('invalid check report', detail)

    def test_a_malformed_run_report_exits_two_with_a_reason(self):
        import io
        import json as _json

        # 1e999 decodes to inf and the int conversions inside from_wire raise
        # OverflowError, which is neither a KeyError nor a TypeError.
        overflow = _json.dumps({
            'reportId': 'r', 'benchmarkId': 'fixture', 'benchmarkVersion': 1,
            'contractVersion': 'v2', 'sdkVersion': '0', 'pluginVersion': '0',
            'repositoryId': None, 'repositoryFullName': None, 'sha': None,
            'dirty': False, 'startedAt': 1e999, 'finishedAt': 2,
            'metrics': [], 'diagnostics': [], 'outputDigest': 'd' * 64,
        })
        for value in (None, '{}', '[]', 'not json', overflow):
            with self.subTest(value=repr(value)[:40]):
                with patch.object(cli.isolate, '_isolation_backend',
                                  side_effect=lambda: cli.isolate.run_operation), \
                        patch.object(cli.isolate, 'run_operation',
                                     return_value=self._completed(value)), \
                        patch.object(cli, 'load_benchmark', return_value=object()), \
                        patch('sys.stdout', new_callable=io.StringIO) as output:
                    code = cli.main(['run', '--benchmark', 'fixture', '--json'])
                self.assertEqual(code, 2)
                record = _json.loads(output.getvalue())
                self.assertEqual(record['status'], isolate.CRASHED)
                self.assertIn('invalid run report', record['detail'])

