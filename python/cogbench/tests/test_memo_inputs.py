from __future__ import annotations

import io
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "python" / "cogbench" / "src"))

from cogbench import memo  # noqa: E402


class InputKeyTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.source = self.root / "theirs.py"
        self.source.write_bytes(b"def features(value): return value\n")

    def key(self, inputs):
        return memo.fingerprint([self.source], benchmark="mini", inputs=inputs)

    def test_equal_inputs_and_unchanged_bytes_are_stable(self):
        def inputs():
            return {"fixture": [None, True, 7, -2.5, "text", b"bytes", (1, 2)],
                    "tunings": {"threshold": 0.25}}

        before = self.key(inputs())
        self.assertTrue(before)
        self.source.write_bytes(self.source.read_bytes())
        self.assertEqual(before, self.key(inputs()))

    def test_omitted_inputs_still_work_and_mean_none(self):
        key = memo.fingerprint([self.source], benchmark="mini")
        self.assertTrue(key)
        self.assertEqual(key, self.key(None))

    def test_builtin_types_have_distinct_encodings(self):
        values = (None, False, 0, 0.0, "", b"", [], (), {}, True, 1, 1.0,
                  [1, 2], (1, 2), "bytes", b"bytes", -0.0)
        keys = [self.key(value) for value in values]
        self.assertTrue(all(keys))
        self.assertEqual(len(keys), len(set(keys)))

    def test_changed_nested_input_changes_key(self):
        self.assertNotEqual(
            self.key({"fixture": [(1, 44100)], "tuning": 2}),
            self.key({"fixture": [(1, 44100)], "tuning": 3}),
        )

    def test_dict_insertion_order_is_preserved(self):
        left = {"a": 1, "b": 2}
        right = {"b": 2, "a": 1}
        self.assertEqual(left, right)
        self.assertNotEqual(self.key(left), self.key(right))
        self.assertNotEqual(self.key([left]), self.key([right]))

    def test_scalar_lengths_and_container_boundaries_are_unambiguous(self):
        pairs = (
            (["ab", "c"], ["a", "bc"]),
            ([b"a\x00", b"b"], [b"a", b"\x00b"]),
            ([[1], [2]], [[1, 2], []]),
            ({"a": "s1:b"}, {"as1:": "b"}),
        )
        for left, right in pairs:
            with self.subTest(left=left):
                self.assertNotEqual(self.key(left), self.key(right))

    def test_finite_float_range_and_large_integers_are_supported(self):
        values = (sys.float_info.max, -sys.float_info.max,
                  float.fromhex("0x0.0000000000001p-1022"),
                  1 << 20000, -(1 << 20000))
        keys = [self.key(value) for value in values]
        self.assertTrue(all(keys))
        self.assertEqual(len(keys), len(set(keys)))
        self.assertEqual(keys, [self.key(value) for value in values])

    def test_strings_preserve_unicode_and_lone_surrogates(self):
        values = ("é", "é", "\ud800", "\ud801", "\x00")
        keys = [self.key(value) for value in values]
        self.assertTrue(all(keys))
        self.assertEqual(len(keys), len(set(keys)))

    def test_nonfinite_floats_are_misses_even_when_nested(self):
        for value in (float("nan"), float("inf"), -float("inf")):
            self.assertEqual(self.key(value), "")
            self.assertEqual(self.key({"fixture": [value]}), "")

    def test_cycles_and_shared_mutable_inputs_are_misses(self):
        circular_list = []
        circular_list.append(circular_list)
        circular_dict = {}
        circular_dict["self"] = circular_dict
        indirect = []
        indirect.append((indirect,))
        for value in (circular_list, circular_dict, indirect):
            self.assertEqual(self.key(value), "")
        shared = [1, {"value": 2}]
        self.assertEqual(self.key([shared, shared]), "")
        self.assertTrue(self.key([[1, {"value": 2}], [1, {"value": 2}]]))
        immutable = (1, "same")
        self.assertTrue(self.key([immutable, immutable]))

    def test_excessive_nesting_is_an_optional_miss(self):
        value = None
        for _ in range(sys.getrecursionlimit() + 10):
            value = [value]
        self.assertEqual(self.key(value), "")

    def test_unknown_inputs_and_paths_are_misses(self):
        for value in (object(), {1, 2}, frozenset([1]), bytearray(b"a"),
                      complex(1, 2), self.source):
            self.assertEqual(self.key(value), "")
            self.assertEqual(self.key([value]), "")

    def test_subclasses_and_opaque_objects_do_not_run_hooks(self):
        calls = []

        def hook(*args, **kwargs):
            calls.append("called")
            raise BaseException("student hook must not run")

        hooks = dict.fromkeys(("__iter__", "__len__", "__getitem__", "items",
                               "__repr__", "__str__", "__bytes__", "__bool__",
                               "__int__", "__float__", "__eq__", "__getattribute__",
                               "__reduce__", "__reduce_ex__"), hook)
        for base in (int, float, str, bytes, list, tuple, dict, object):
            value = type("StudentValue", (base,), hooks)()
            with self.subTest(base=base.__name__):
                self.assertEqual(self.key(value), "")
                self.assertEqual(self.key({"nested": value}), "")
        self.assertEqual(calls, [])

    def test_dict_keys_must_be_exact_strings_without_running_key_hooks(self):
        calls = []

        class StudentString(str):
            def __str__(self):
                calls.append("str")
                raise BaseException("must not stringify keys")

            def encode(self, *args, **kwargs):
                calls.append("encode")
                raise BaseException("must not encode subclass keys")

        for key in (1, False, None, b"key", ("key",), StudentString("key")):
            self.assertEqual(self.key({key: 1}), "")
        self.assertEqual(calls, [])

    def test_missing_and_unreadable_files_return_empty_keys(self):
        missing = self.root / "missing.model"
        self.assertEqual(memo.fingerprint(
            [self.source, missing], benchmark="mini", inputs={"tuning": 2},
        ), "")
        with mock.patch.object(Path, "open", side_effect=PermissionError("denied")):
            self.assertEqual(self.key(None), "")
        with mock.patch.object(Path, "open") as opened:
            opened.return_value.__enter__.return_value.read.side_effect = OSError("read failed")
            self.assertEqual(self.key(None), "")

    def test_changed_resource_bytes_invalidate_unchanged_source_and_inputs(self):
        resource = self.root / "weights.bin"
        resource.write_bytes(b"model one")
        inputs = {"resource": "weights.bin"}
        paths = [self.source, resource]
        before = memo.fingerprint(paths, benchmark="mini", inputs=inputs)
        self.assertTrue(before)
        self.assertEqual(before, memo.fingerprint(
            list(reversed(paths)), benchmark="mini", inputs=inputs,
        ))
        resource.write_bytes(b"model two")
        self.assertNotEqual(before, memo.fingerprint(paths, benchmark="mini", inputs=inputs))

    def test_files_are_read_in_bounded_chunks(self):
        sizes = []

        class BoundedReader(io.BytesIO):
            def read(self, size=-1):
                self_test.assertGreater(size, 0)
                self_test.assertLessEqual(size, 1024 * 1024)
                sizes.append(size)
                return super().read(size)

        self_test = self
        contents = b"x" * (2 * 1024 * 1024 + 7)
        self.source.write_bytes(contents)
        expected = self.key(None)
        with mock.patch.object(Path, "open", return_value=BoundedReader(contents)):
            actual = self.key(None)
        self.assertTrue(actual)
        self.assertEqual(expected, actual)
        self.assertGreaterEqual(len(sizes), 4)


if __name__ == "__main__":
    unittest.main()
