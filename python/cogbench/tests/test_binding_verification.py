"""Bindings expose the evidence needed to replay fits before verification."""

import contextlib
import sys
import unittest
from dataclasses import FrozenInstanceError, replace
from pathlib import Path
from types import ModuleType
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from cogbench.pipeline import (
    Binding, Fixtures, Role, Stage, _MISSING_RECEIVER, _RUNTIME,
    _resolve_branches, _resolve_chain, resolve_chain, runtime_pool,
)


def module(source):
    result = ModuleType("binding_fixture")
    exec(source, result.__dict__)
    return result


def output_stage():
    return Stage("answer", prefers=("answer",), produces=lambda value: type(value) is int)


class BindingVerification(unittest.TestCase):
    def test_legacy_chain_and_branch_arguments_are_unchanged(self):
        source = module("def answer(value): return value + 1")
        single = Role("single", (output_stage(),))
        branched = Role("root", (), branches=(single, replace(single, name="second")))
        for role in (single, branched):
            seen = []
            binding, refusal = resolve_chain(
                role, [source], (2,), verify=lambda value: seen.append(value) or True,
            )
            self.assertIsNone(refusal)
            self.assertIsNotNone(binding)
            if role.branches:
                self.assertEqual([list(value) for value in seen], [["single"], ["single", "second"]])
                self.assertEqual(seen[-1], binding.branches)
            else:
                self.assertIsInstance(seen[0], tuple)
                self.assertEqual(seen[0], binding.steps)

    def test_exclusivity_precedes_discovery_in_every_entry_point(self):
        source = module("def answer(value): raise AssertionError('student ran')")
        role = Role("single", (output_stage(),))
        for resolve in (resolve_chain, _resolve_chain, _resolve_branches):
            with self.subTest(resolve=resolve.__name__):
                with patch("cogbench.pipeline.callables_in", side_effect=AssertionError("discovery ran")):
                    with self.assertRaisesRegex(ValueError, "only one of verify and verify_binding"):
                        resolve(role, [source], (2,), verify=lambda _: True, verify_binding=lambda _: True)

    def test_function_fit_preserves_form_plan_and_original_stage_index(self):
        source = module('''
def fit(rows, cutoff, *, resource):
    if not isinstance(rows, list) or cutoff != 7:
        raise ValueError("wrong form or tuning")
    class Project:
        pass
    result = Project()
    result.value = sum(rows) + resource + cutoff
    return result

def answer(value, project):
    return value + project.value
''')
        role = Role("root", (
            Stage("skipped", fit=True, optional=True, fixture=(None,), produces=lambda _: False),
            output_stage(),
            Stage("project", prefers=("fit",), fit=True,
                  fixture=Fixtures((("bad",), ([2, 3],))), extras=("resource",),
                  tunings=(7,), produces=lambda value: hasattr(value, "value")),
        ))
        role = replace(role, stages=(role.stages[0], replace(role.stages[1], extras=("project",)), role.stages[2]))
        seen = []

        def verify(binding):
            seen.append(binding)
            fit = binding.fits[0][1]
            fresh = fit.bound([10])
            return binding.steps[0].bound(1) == 24 and fresh.value == 28

        binding, refusal = resolve_chain(role, [source], (1,), extras={"resource": 11}, verify_binding=verify)
        self.assertIsNone(refusal)
        self.assertTrue(seen)
        fit = binding.fits[0][1]
        self.assertEqual(fit.form, 1)
        self.assertEqual(fit.plan, ("value", "tuning"))
        self.assertEqual(fit.keywords, ("resource",))
        self.assertEqual(fit.tuning, 7)
        self.assertEqual(fit.supplied["resource"], 11)
        self.assertEqual(fit._fit_provenance.role_path, ("root",))
        self.assertEqual(fit._fit_provenance.stage_index, 2)
        self.assertIsNone(fit._fit_provenance.export_attribute)
        self.assertIs(replace(fit, form=0)._fit_provenance, fit._fit_provenance)
        with self.assertRaises(FrozenInstanceError):
            fit._fit_provenance.stage_index = 0
        self.assertEqual(seen[-1]._value, 24)
        self.assertEqual(len(seen[-1].observations()), 1)
        self.assertEqual(seen[-1]._stage_names, ("answer",))

    def test_module_value_fit_records_exact_export_attribute(self):
        source = module("TABLE = {'saved': 9}\ndef answer(value, table): return value + table['saved']")
        # Attribute names need not be Python identifiers. Do not split labels on dots.
        setattr(source, "a.b", source.TABLE)
        del source.TABLE
        role = Role("root", (
            Stage("table", fit=True, fixture=(None,), produces=lambda value: isinstance(value, dict)),
            replace(output_stage(), extras=("table",)),
        ))
        seen = []
        binding, refusal = resolve_chain(role, [source], (1,), verify_binding=lambda b: seen.append(b) or True)
        self.assertIsNone(refusal)
        fit = binding.fits[0][1]
        self.assertEqual(fit._fit_provenance.export_attribute, "a.b")
        self.assertEqual(fit.module, source.__name__)
        self.assertIs(getattr(source, fit._fit_provenance.export_attribute), fit.bound())
        self.assertEqual(seen[0].fits, binding.fits)

    def test_branch_fits_keep_scope_and_binding_order_despite_optional_skips(self):
        source = module('''
def fit(value): return {"number": value}
def answer(value, table): return value + table["number"]
''')
        def fit(value):
            return Stage("table", prefers=("fit",), fit=True, fixture=(value,),
                         produces=lambda result: isinstance(result, dict))
        first = Role("first", (fit(10), replace(output_stage(), extras=("table",))), fixture=(1,))
        second = Role("second", (
            Stage("unused", fit=True, optional=True, fixture=(None,), produces=lambda _: False),
            replace(output_stage(), extras=("table",)), fit(20),
        ), fixture=lambda pool, chains: (pool["first"],))
        absent = Role("absent", (Stage("no", produces=lambda _: False),), optional=True)
        role = Role("root", (fit(100),), branches=(second, first, absent))
        seen = []
        binding, refusal = resolve_chain(role, [source], (0,), verify_binding=lambda b: seen.append(b) or True)
        self.assertIsNone(refusal)
        self.assertEqual([list(b.branches) for b in seen], [["first"], ["first", "second"]])
        self.assertEqual([b._value for b in seen], [11, 31])
        for trial in seen:
            current = list(trial.branches)[-1]
            self.assertEqual(trial.steps, trial.branches[current])
            self.assertEqual(len(trial.observations()), 1)
        self.assertEqual(list(binding.missing), ["absent"])
        expected = [(("root",), 0, 100), (("root", "first"), 0, 10), (("root", "second"), 2, 20)]
        for trial in (seen[-1], binding):
            self.assertEqual([name for name, _ in trial.fits], ["table"] * 3)
            for (_, selected), (path, index, value) in zip(trial.fits, expected):
                self.assertEqual(selected._fit_provenance.role_path, path)
                self.assertEqual(selected._fit_provenance.stage_index, index)
                declaring = role if len(path) == 1 else next(b for b in role.branches if b.name == path[1])
                self.assertEqual(selected.bound(*declaring.stages[index].fixture), {"number": value})

    def test_fit_constructor_receiver_restoration_without_method_enumeration(self):
        source = module('''
class Store:
    def __init__(self, rows):
        if not isinstance(rows, list): raise TypeError("rows required")
        self.rows = rows
    def answer(self, value): return sum(self.rows) + value

def answer(value, store): return store.answer(value)
''')
        fit_stage = Stage("store", fit=True, fixture=([3],), produces=lambda value: isinstance(value, source.Store))
        answer = replace(output_stage(), extras=("store",))
        single = Role("single", (fit_stage, answer))
        # Root fit and prior-branch fit receivers must remain protected even
        # while an independent later branch is being verified.
        branched = Role("root", (fit_stage,), branches=(
            Role("first", (replace(fit_stage, name="local"), replace(answer, extras=("local",)))),
            Role("second", (answer,)),
        ))
        for role in (single, branched):
            for fail in (False, True):
                for scoped in (False, True):
                    with self.subTest(branches=bool(role.branches), fail=fail, scoped=scoped):
                        captured = []
                        def verify(binding):
                            self.assertEqual(binding._reach, ())
                            self.assertEqual(binding._value, 5)
                            for _, selected in binding.fits:
                                self.assertIs(selected.call, source.Store)
                                owner = selected.receiver.get()
                                self.assertEqual(owner.rows, [3])
                                captured.append((selected.receiver, owner))
                                selected.bound([50])
                                self.assertEqual(selected.receiver.get().rows, [50])
                            if fail:
                                raise KeyboardInterrupt("verifier failed")
                            return True
                        before = dict(_RUNTIME)
                        with runtime_pool({}) if scoped else contextlib.nullcontext():
                            binding, refusal = resolve_chain(role, [source], (2,), verify_binding=verify)
                            self.assertTrue(captured)
                            for receiver, owner in captured:
                                self.assertIs(receiver.get(), owner)
                        self.assertEqual(_RUNTIME, before)
                        if fail:
                            self.assertIsNone(binding)
                            self.assertTrue(refusal.ran_to_the_end)
                        else:
                            self.assertIsNone(refusal)
                            for _, selected in binding.fits:
                                self.assertIs(selected.receiver.get(), _MISSING_RECEIVER)
                                self.assertIsNotNone(selected._fit_provenance)
                            self.assertEqual(binding._reach, ())

    def test_branch_reach_retains_distinct_owners_without_widening_search(self):
        source = module('''
class Store:
    def __init__(self, rows):
        if not isinstance(rows, list): raise TypeError("rows required")
        self.rows = rows
    def answer(self, value):
        if not isinstance(value, int): raise TypeError("integer required")
        return sum(self.rows) + value

def zanswer(value):
    if not isinstance(value, str): raise TypeError("string required")
    return value

def finish(value, switch):
    if value != "done" or switch != "good": raise ValueError("not ready")
    return True
''')
        construct = Stage("construct", produces=lambda value: isinstance(value, source.Store))
        first = Role("first", (construct,), fixture=([10],))
        second = Role("second", (construct,), fixture=([20],))
        switch_stage = Stage("switch", produces=lambda value: isinstance(value, str))
        for backtrack in (False, True):
            for scoped in (False, True):
                with self.subTest(backtrack=backtrack, scoped=scoped):
                    switch = Role("switch", (switch_stage,), fixture=("ready",))
                    branches = (first, second, switch)
                    if backtrack:
                        switch = replace(switch, fixture=Fixtures((("bad",), ("good",))))
                        last = Role("last", (Stage("finish", extras=("switch",),
                                    produces=lambda value: value is True),), fixture=("done",))
                        branches = (first, second, switch, last)
                    role = Role("root", (), branches=branches)
                    seen = []
                    captured = []
                    searches = []

                    def inspect_search(branch, *args, **kwargs):
                        searches.append((branch.name, tuple(kwargs["carried"])))
                        return _resolve_chain(branch, *args, **kwargs)

                    def verify(binding):
                        methods = [step for step in binding._reach if step.attribute == "answer"]
                        owners = [step.receiver.get() for step in methods]
                        rows = [owner.rows for owner in owners]
                        seen.append((tuple(binding.branches), rows))
                        expected = [[10]] if len(binding.branches) == 1 else [[10], [20]]
                        self.assertEqual(rows, expected)
                        self.assertEqual(len({id(step.receiver) for step in methods}), len(methods))
                        for step, owner, name in zip(methods, owners, ("first", "second")):
                            build = binding.branches[name][0]
                            self.assertIs(step.receiver, build.receiver)
                            captured.append((step.receiver, owner))
                            build.bound([99])
                            self.assertEqual(step.bound(1), 100)
                        return True

                    with runtime_pool({}) if scoped else contextlib.nullcontext():
                        with patch("cogbench.pipeline._resolve_chain", side_effect=inspect_search):
                            binding, refusal = resolve_chain(role, [source], (), verify_binding=verify)
                        self.assertIsNone(refusal)
                        self.assertTrue(captured)
                        for receiver, owner in captured:
                            self.assertIs(receiver.get(), owner)
                    self.assertEqual(seen[0][1], [[10]])
                    self.assertTrue(all(rows == [[10], [20]] for _, rows in seen[1:]))
                    methods = [step for step in binding._reach if step.attribute == "answer"]
                    self.assertEqual([step.branch for step in methods], ["first", "second"])
                    self.assertIsNot(methods[0].receiver, methods[1].receiver)
                    for step, name in zip(methods, ("first", "second")):
                        self.assertIs(step.receiver, binding.branches[name][0].receiver)
                        self.assertIs(step.receiver.get(), _MISSING_RECEIVER)
                    # Evidence retains both owners, but both initial and restored
                    # searches still receive only the first method per label.
                    for name, candidates in searches:
                        if name in ("switch", "last"):
                            methods = [step for step in candidates if step.attribute == "answer"]
                            self.assertEqual(len(methods), 1)
                            self.assertEqual(methods[0].branch, "first")
                    if backtrack:
                        self.assertEqual(binding.branches["switch"][0].form, 1)
                        self.assertGreaterEqual(sum(name == "switch" for name, _ in searches), 2)
                        self.assertEqual(sum(name == "first" for name, _ in searches), 1)
                        self.assertEqual(sum(name == "second" for name, _ in searches), 1)

    def _assert_fit_search_unchanged(self, source, expected):
        fit = Stage("store", fit=True, fixture=([9],),
                    produces=lambda value: isinstance(value, source.Store))
        single = Role("single", (fit, output_stage()))
        root_fit = Role("root", (fit,), branches=(Role("branch", (output_stage(),)),))
        branch_fit = Role("root", (), branches=(single,))
        for role in (single, root_fit, branch_fit):
            for api in ("verify", "verify_binding"):
                with self.subTest(role=role, api=api, expected=expected):
                    calls = []
                    binding, refusal = resolve_chain(
                        role, [source], (2,),
                        **{api: lambda value: calls.append(value) or True}
                    )
                    if expected is None:
                        self.assertIsNone(binding)
                        self.assertIsNotNone(refusal)
                        self.assertFalse(calls)
                    else:
                        self.assertIsNone(refusal)
                        chain = next(iter(binding.branches.values())) if role.branches else binding.steps
                        self.assertEqual([candidate.label for candidate in chain], ["binding_fixture.zanswer"])
                        self.assertEqual(chain[0].bound(2), expected)
                        self.assertEqual(binding._reach, ())
                        if api == "verify_binding":
                            self.assertEqual(calls[-1]._value, expected)

    def test_fit_methods_do_not_make_a_previously_refused_role_bind(self):
        source = module('''
class Store:
    def __init__(self, rows):
        if not isinstance(rows, list): raise TypeError("rows required")
        self.rows = rows
    def answer(self, value): return sum(self.rows) + value
''')
        self._assert_fit_search_unchanged(source, None)

    def test_fit_method_does_not_displace_the_existing_function(self):
        source = module('''
class Store:
    def __init__(self, rows):
        if not isinstance(rows, list): raise TypeError("rows required")
        self.rows = rows
    def answer(self, value): return sum(self.rows) + value

def zanswer(value): return 100
''')
        self._assert_fit_search_unchanged(source, 100)

    def test_selected_fit_with_raising_dir_is_not_inspected_for_methods(self):
        source = module('''
class Store:
    def __init__(self, rows):
        if not isinstance(rows, list): raise TypeError("rows required")
        self.rows = rows
    def __dir__(self): raise RuntimeError("fit methods must not be inspected")

def zanswer(value): return 100
''')
        self._assert_fit_search_unchanged(source, 100)

    def test_false_and_raising_callbacks_are_contained_and_search_continues(self):
        source = module("def a(value): return value + 1\ndef b(value): return value + 2")
        role = Role("root", (output_stage(),))
        for failure in (False, RuntimeError("bad result"), SystemExit("student exit")):
            seen = []
            def verify(binding):
                seen.append(binding.steps[0].label)
                if len(seen) == 1:
                    if isinstance(failure, BaseException):
                        raise failure
                    return failure
                return True
            binding, refusal = resolve_chain(role, [source], (1,), verify_binding=verify)
            self.assertIsNone(refusal)
            self.assertEqual(len(seen), 2)
            self.assertEqual(binding.steps[0].label, seen[-1])


if __name__ == "__main__":
    unittest.main()
