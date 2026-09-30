"""Cold imports must not count as reads of a folder's input photos."""

from __future__ import annotations

import importlib.machinery
import importlib.util
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from cogbench import pipeline


def _exercise(case):
    # Each case runs in its own interpreter: a warm finder cache hides the
    # directory scans made by the first import on the successful retry.
    with tempfile.TemporaryDirectory(prefix="cog-folder-import-") as directory:
        root = Path(directory).resolve()
        package = root / "cold_photo_reader"
        package.mkdir()
        (package / "__init__.py").write_text("", encoding="utf-8")
        outside = root / "own-photos"
        outside.mkdir()
        (outside / "own.png").write_bytes(b"own photo")
        preamble = ""
        if case == "import_body":
            preamble = "import os\nos.listdir({!r})\n".format(str(outside))
        (package / "reader.py").write_text(
            preamble + "def read(path):\n    return path.read_bytes()\n", encoding="utf-8",
        )
        files = [root / "one.png", root / "two.png"]
        for path in files:
            path.write_bytes(b"supplied photo")
        extra = ""
        if case == "direct_package_listing":
            extra = "    os.listdir({!r})\n".format(str(package))
        elif case == "spoofed_import_frame":
            # Names and filenames alone do not prove the importer made a scan.
            fake = "def _fill_cache():\n    os.listdir({!r})\n_fill_cache()\n".format(str(outside))
            extra = "    exec(compile({!r}, '<frozen importlib._bootstrap_external>', 'exec'))\n".format(fake)
        source = (
            "import os\nfrom pathlib import Path\n"
            "def build():\n"
            "    paths = sorted(Path('baseImages').iterdir())\n"
            "    from cold_photo_reader.reader import read\n"
            + extra + "    return [read(path) for path in paths]\n"
        )
        if case == "import_scan_only":
            source = (
                "import os\nfrom importlib.machinery import FileFinder\n"
                "tried = False\n"
                "def build():\n"
                "    global tried\n"
                "    if not tried:\n"
                "        tried = True\n"
                "        return os.listdir('baseImages')\n"
                "    FileFinder('baseImages').find_spec('absent')\n"
                "    return [b'supplied photo', b'supplied photo']\n"
            )
        path = root / "student.py"
        path.write_text(source, encoding="utf-8")
        spec = importlib.util.spec_from_file_location("student", str(path))
        module = importlib.util.module_from_spec(spec)
        sys.modules["student"] = module
        spec.loader.exec_module(module)
        sys.path.insert(0, str(root))
        assert "cold_photo_reader" not in sys.modules
        scans = []

        def observe(event, arguments):
            if event == "os.listdir" and pipeline._WATCHED is not None:
                scans.append(
                    sys._getframe(1).f_code is importlib.machinery.FileFinder._fill_cache.__code__
                )

        sys.addaudithook(observe)
        role = pipeline.Role("photos", (
            pipeline.Stage("read", produces=lambda value: value == [b"supplied photo"] * 2, folder=True),
        ))
        binding, refusal = pipeline.resolve_chain(role, [module], (files,))
        return {
            "bound": binding is not None,
            "folder": binding.steps[0].supplied.get("folder") if binding else None,
            "notes": list(refusal.notes) if refusal else [],
            "import_scans": sum(scans),
        }


class ColdFolderImports(unittest.TestCase):
    def cold(self, case):
        process = subprocess.run(
            [sys.executable, "-B", str(Path(__file__).resolve()), "--fixture=" + case],
            capture_output=True, text=True, timeout=30,
        )
        self.assertEqual(process.returncode, 0, process.stderr)
        result = json.loads(process.stdout)
        self.assertGreater(result["import_scans"], 0, "fixture did not exercise a cold finder")
        return result

    def test_dependency_import_can_precede_reading_supplied_photos(self):
        result = self.cold("clean")
        self.assertTrue(result["bound"], result["notes"])
        self.assertEqual(result["folder"], "baseImages")

    def test_data_listing_during_import_is_still_refused(self):
        result = self.cold("import_body")
        self.assertFalse(result["bound"])
        self.assertTrue(any("own-photos" in note for note in result["notes"]))

    def test_student_listing_a_dependency_directory_is_still_refused(self):
        result = self.cold("direct_package_listing")
        self.assertFalse(result["bound"])
        self.assertTrue(any("cold_photo_reader" in note for note in result["notes"]))

    def test_importer_filename_and_function_name_do_not_hide_data_reads(self):
        result = self.cold("spoofed_import_frame")
        self.assertFalse(result["bound"])
        self.assertTrue(any("own-photos" in note for note in result["notes"]))

    def test_import_scan_alone_is_not_supplied_input_evidence(self):
        result = self.cold("import_scan_only")
        self.assertFalse(result["bound"])


if __name__ == "__main__":
    if len(sys.argv) == 2 and sys.argv[1].startswith("--fixture="):
        print(json.dumps(_exercise(sys.argv[1].split("=", 1)[1])))
    else:
        unittest.main()
