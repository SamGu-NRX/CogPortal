"""A failure's `detail` says when it was cut.

`detail` is one string on the wire with a hard 240-character cap, so unlike a
diagnostic note there is nowhere to put the remainder. It was sliced at exactly
240, which landed mid-word: staging run `run_158c8e88c3` showed a run page
ending "...trying to locate the file on the Hub a", which reads as the sentence
the benchmark wrote rather than as a truncation.

These tests pin the two halves: the cap is still respected, and a cut is
visible and falls between words.
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


#: The message that produced the defect, from run_158c8e88c3.
CELEBA_FAILURE = (
    "The search for your code could not run: Couldn't find any data file at "
    "/flwrlabs/celeba. Couldn't find 'flwrlabs/celeba' on the Hugging Face Hub "
    "either: LocalEntryNotFoundError: An error happened while trying to locate "
    "the file on the Hub and we cannot find the requested files in the local cache."
)


class ACutDetailSaysSo(unittest.TestCase):
    def setUp(self):
        self.modal_app = _modal_app()

    def test_the_wire_cap_is_still_respected(self):
        detail = self.modal_app._failure_detail(CELEBA_FAILURE)

        self.assertLessEqual(len(detail), 240)

    def test_a_cut_is_visible_and_between_words(self):
        detail = self.modal_app._failure_detail(CELEBA_FAILURE)

        self.assertTrue(detail.endswith(" ..."), detail[-40:])
        # The old slice ended "on the Hub a", half of "and".
        self.assertFalse(detail.rstrip(". ").endswith(" a"), detail[-40:])

    def test_a_message_that_fits_is_handed_over_untouched(self):
        short = "Official Week 2 data is missing or failed integrity validation."

        self.assertEqual(self.modal_app._failure_detail(short), short)
