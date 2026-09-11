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
from cogbench.models import LocalReport, Metric, RepositoryState
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

    def test_local_metric_metadata_and_weights_survive_json_roundtrip(self):
        metrics = [
            Metric('metric_' + role, role, 0.25, None, True, role == 'scored', 3,
                   help='What this measures.', role=role,
                   relates_to=None if role == 'scored' else 'metric_scored')
            for role in ('scored', 'floor', 'reported', 'diagnostic')
        ]
        report = LocalReport(
            report_id='local_roles', benchmark_id='fixture', benchmark_version=1,
            contract_version='cogworks.submissions.v2', sdk_version='0.2.0',
            plugin_version='1', repository=RepositoryState(None, 'course/team', 'a' * 40, False),
            started_at=1, finished_at=2, metrics=metrics,
            diagnostics=['The findings remain available.'], output_digest='b' * 64,
            weights_used=['model.pkl'],
            weights_uploaded=[{'path': 'model.pkl', 'sha256': 'c' * 64}],
        )
        restored = LocalReport.from_json(report.to_json())
        self.assertEqual(restored, report)
        self.assertEqual(restored.to_wire(), report.to_wire())

    def test_legacy_metric_metadata_stays_absent(self):
        metric = Metric('score', 'Score', 0.25, None, True, True, 3)
        wire = metric.to_wire()
        for metadata in ({}, {'role': None, 'relatesTo': None}):
            with self.subTest(metadata=metadata):
                restored = Metric.from_wire(dict(wire, **metadata))
                self.assertEqual(restored, metric)
                self.assertEqual(restored.to_wire(), wire)
                self.assertNotIn('role', restored.to_wire())
                self.assertNotIn('relatesTo', restored.to_wire())

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
        view = {'report': report.to_dict(), 'survey': {'modules': []}}
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
