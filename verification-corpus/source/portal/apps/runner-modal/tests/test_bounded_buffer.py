"""The sandbox log buffer keeps both ends of the stream.

The benchmark prints its showcase lines after the submission has run, into the
same captured stream. A head-only cap meant a submission that printed a lot
silently pushed those lines out, which is how a cloud canary once observed zero
showcase lines while the same code produced ten locally. These tests pin the
property that matters: the tail survives a chatty submission.
"""

from __future__ import annotations

import ast
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "apps" / "runner-modal" / "src"))


def _bounded_buffer_class():
    """Pull BoundedBuffer out of EVALUATE_SCRIPT by AST.

    The script is a string literal that runs inside the sandbox, so it cannot
    be imported. Reading it the same way the parity tool does keeps this test
    honest about testing the code that actually ships.
    """

    source = (
        ROOT / "apps" / "runner-modal" / "src" / "cogworks_runner" / "modal_app.py"
    ).read_text(encoding="utf-8")
    module = ast.parse(source)
    for node in module.body:
        if isinstance(node, ast.Assign) and any(
            getattr(t, "id", None) == "EVALUATE_SCRIPT" for t in node.targets
        ):
            script = ast.literal_eval(node.value)
            break
    else:  # pragma: no cover - structural guard
        raise AssertionError("EVALUATE_SCRIPT not found in modal_app.py")

    namespace: dict = {}
    tree = ast.parse(script)
    wanted = [
        n
        for n in tree.body
        if (isinstance(n, ast.ClassDef) and n.name == "BoundedBuffer")
        or isinstance(n, (ast.Import, ast.ImportFrom))
    ]
    # Drop the cogbench import; only the stdlib ones matter for the buffer.
    wanted = [
        n
        for n in wanted
        if not (
            isinstance(n, ast.ImportFrom) and (n.module or "").startswith("cogbench")
        )
    ]
    exec(
        compile(ast.Module(body=wanted, type_ignores=[]), "<evaluate>", "exec"),
        namespace,
    )
    return namespace["BoundedBuffer"]


BoundedBuffer = _bounded_buffer_class()


class BoundedBufferTests(unittest.TestCase):
    def test_short_output_is_untouched(self):
        buf = BoundedBuffer(100)
        buf.write("hello\n")
        buf.write("world\n")
        self.assertEqual(buf.value(), "hello\nworld\n")

    def test_write_reports_full_length_even_when_capped(self):
        # print() relies on write() returning what it was given.
        buf = BoundedBuffer(10)
        self.assertEqual(buf.write("x" * 50), 50)

    def test_trailing_lines_survive_a_chatty_submission(self):
        # Production numbers: the portal sends maxOutputBytes 8*1024, and a real
        # showcase line carries a caption plus three COCO URLs (~270 chars), so
        # the whole block is ~2.7 KB.
        limit = 8 * 1024
        url = "http://images.cocodataset.org/train2014/COCO_train2014_000000084887.jpg"
        buf = BoundedBuffer(limit)
        buf.write("student python 3.8.20\n")
        for i in range(2000):
            buf.write("noisy debug line {} from a chatty adapter\n".format(i))
        for i in range(1, 11):
            buf.write(
                'showcase {:02d}/10 "a caption about a scene" -> {} {} {}\n'.format(
                    i, url, url, url
                )
            )

        value = buf.value()
        showcase = [line for line in value.splitlines() if line.startswith("showcase ")]
        self.assertEqual(len(showcase), 10, value[-500:])
        # Every one is whole, not clipped mid-line.
        for line in showcase:
            self.assertTrue(line.endswith(".jpg"), line)
        # The head survives too, so an early traceback is not lost.
        self.assertTrue(value.startswith("student python 3.8.20\n"))
        self.assertIn("characters omitted", value)

    def test_total_size_stays_within_the_limit(self):
        limit = 500
        buf = BoundedBuffer(limit)
        for i in range(2000):
            buf.write("line {}\n".format(i))
        # The omission marker is the only addition beyond the cap.
        self.assertLessEqual(buf.head_len + buf.tail_len, limit)

    def test_single_write_larger_than_the_limit_keeps_both_ends(self):
        # One oversized write still splits: head takes limit//2, the tail keeps
        # the most recent characters up to the remaining budget.
        buf = BoundedBuffer(60)
        buf.write("A" * 40 + "B" * 200 + "Z" * 20)
        value = buf.value()
        self.assertTrue(value.startswith("A" * 30), value[:60])
        self.assertTrue(value.endswith("Z" * 20), value[-60:])
        self.assertIn("characters omitted", value)


if __name__ == "__main__":
    unittest.main()
