"""A scorer's note reaches the run page whole.

Each note is one instruction about what to change next. The runner used to put
them on the wire with `str(item)[:240]`, a hard slice at a length the scorers
exceed, so the run page showed sentences ending "and", "not hid", and "give you
on". What the slice removed was the end of the note, which is where the advice
is; what it kept was the beginning, which is the part describing the problem the
student already knew they had.

These tests pin the two halves of the fix: the limit is high enough for the
notes the benchmarks actually write, and a note past the limit breaks between
words rather than inside one.
"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "apps" / "runner-modal" / "tools"))


def _modal_app():
    """The shipped module, with modal and fastapi stubbed the usual way."""

    import image_manifest

    image_manifest._stub_modules()
    sys.path.insert(0, str(ROOT / "apps" / "runner-modal" / "src"))
    from cogworks_runner import modal_app

    return modal_app


#: The longest note measured in the three benchmark submodules, week 2's
#: "every probe abstained" template at 392 characters. The number is what makes
#: 600 a bound rather than a guess, so it is stated here rather than described.
LONGEST_REAL_NOTE = 392


class ANoteArrivesWhole(unittest.TestCase):
    def setUp(self):
        self.modal_app = _modal_app()

    def test_the_limit_clears_the_longest_note_the_scorers_write(self):
        self.assertGreater(
            self.modal_app.DIAGNOSTIC_LIMIT,
            LONGEST_REAL_NOTE,
            "a scorer note that exists today would still be shortened",
        )

    def test_a_real_length_note_is_not_touched(self):
        # The week 1 ranking note, at the length that produced the "and" on the
        # run page.
        note = "word " * 62 + "and that the same code path resamples both."
        self.assertGreater(len(note), 240, "this fixture has to exceed the old limit")
        self.assertEqual(self.modal_app._diagnostic_lines(note), [note.strip()])

    def test_a_note_past_the_limit_breaks_between_words(self):
        note = "supercalifragilistic " * 60
        lines = self.modal_app._diagnostic_lines(note)

        self.assertGreater(len(lines), 1, "a note this long has to be split")
        for line in lines:
            self.assertLessEqual(len(line), self.modal_app.DIAGNOSTIC_LIMIT)
        # Nothing was dropped, and no word was cut in half.
        self.assertEqual(" ".join(lines).split(), note.split())

    def test_one_word_longer_than_the_limit_still_returns_something(self):
        """A single unbroken token has no word boundary to break on.

        Splitting inside it is the only option left, and returning nothing
        would drop the note entirely.
        """

        note = "x" * (self.modal_app.DIAGNOSTIC_LIMIT + 50)
        lines = self.modal_app._diagnostic_lines(note)

        self.assertTrue(lines)
        for line in lines:
            self.assertLessEqual(len(line), self.modal_app.DIAGNOSTIC_LIMIT)
        self.assertEqual("".join(lines), note)

    def test_an_empty_note_does_not_disappear_into_nothing(self):
        self.assertEqual(self.modal_app._diagnostic_lines(""), [""])

    def test_a_non_string_note_is_still_readable(self):
        self.assertEqual(self.modal_app._diagnostic_lines(42), ["42"])


class TheWireLimitsAgree(unittest.TestCase):
    """The runner shortens to its own constant and the portal validates against
    a schema written in another language. Two numbers, one contract: if they
    drift apart the worker answers 400 and `_post_event` does not retry a 400,
    so the whole completed event is lost rather than a few characters."""

    def test_the_runner_limit_matches_the_wire_schema(self):
        protocol = (ROOT / "packages" / "contracts" / "src" / "protocol.ts").read_text(
            encoding="utf-8"
        )
        self.assertIn(
            "diagnostics: z.array(z.string().max(600)).max(32),",
            protocol,
            "packages/contracts no longer accepts what the runner sends",
        )
        self.assertEqual(_modal_app().DIAGNOSTIC_LIMIT, 600)

    def test_the_browser_schema_accepts_what_the_worker_stores(self):
        schema = (ROOT / "packages" / "contracts" / "src" / "schema.ts").read_text(
            encoding="utf-8"
        )
        self.assertIn(
            "diagnostics: z.array(z.string().max(600)).max(32),",
            schema,
            "a stored note the browser refuses blanks the whole run page",
        )


if __name__ == "__main__":
    unittest.main()
