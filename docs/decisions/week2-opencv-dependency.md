# Week 2 needs OpenCV, and nothing says so

**Status:** open. The hosted path is unaffected; local runs fail without a
manual install. The fix belongs in the Week 2 submodule, which carries
uncommitted work, so it is recorded here rather than applied.

## What happens

Scoring any Week 2 submission on a clean machine fails inside a third-party
library, several frames below anything we or the student wrote:

```
File ".../facenet_models/__init__.py", line 75, in compute_descriptors
    [crop_resize(image, [int(max(0, coord)) for coord in box], 160)
File ".../facenet_pytorch/models/utils/detect_face.py", line 312, in crop_resize
    out = cv2.resize(
NameError: name 'cv2' is not defined
```

Not `ModuleNotFoundError`. `facenet_pytorch.models.utils.detect_face` imports
`cv2` inside a `try`/`except ImportError` and carries on without it, so the
name is simply absent when `crop_resize` runs. A missing dependency therefore
surfaces as a `NameError` about an undefined variable, which reads like a bug
in the library rather than a package the machine does not have.

`crop_resize` runs on every descriptor computation, so this is not an edge
case: no Week 2 submission can be scored at all.

## Why the hosted path is fine

`benchmark_image` installs `opencv-python-headless==4.10.0.84`
(`apps/runner-modal/src/cogworks_runner/modal_app.py:97`). That pin predates
this finding and was presumably added for the same reason, but it is only in
the image.

`benchmarks/week2/pyproject.toml:13-17` declares `numpy`, `Pillow`, and
`platformdirs`. Neither `facenet-pytorch` nor OpenCV appears in the runtime
dependencies or in any extra, so `pip install -e benchmarks/week2` produces an
environment that cannot score.

That split is the actual defect. The image and the package disagree about what
Week 2 needs, and the image is right. A student following the local
instructions, or a staff member running `pnpm test:python` on a fresh checkout,
gets the `NameError`; only the hosted runner works.

## The fix

Add to `benchmarks/week2/pyproject.toml`:

```toml
dependencies = [
  "numpy>=1.24,<2",
  "Pillow>=10.2,<11",
  "platformdirs>=4,<5",
  # facenet-pytorch calls cv2.resize when cropping a detected face, but
  # imports cv2 under a bare `except ImportError` and continues without it,
  # so its absence appears as `NameError: name 'cv2' is not defined` from
  # inside detect_face.py rather than as a missing module. Headless because
  # nothing here opens a window; the full build pulls in GUI libraries a
  # sandbox does not have.
  "opencv-python-headless>=4.10,<5",
]
```

`facenet-pytorch` and `facenet_models` themselves stay out of the declared
dependencies: `facenet_models` is a git dependency the course installs, and
pinning a git URL in a published package is worse than the status quo. What
this changes is only the package that is silently assumed present.

Not applied here because `benchmarks/week2` is a submodule with uncommitted
changes to `plugins.py`, `tests/test_entry_points.py`, and two README files.
Editing it would fold an unrelated fix into that work.

## How it was found

Scoring `LashikaKapoor28/Vision_Module_Capstone` through a new
instructor-supplied adapter, on a machine that had every declared dependency
installed. The Week 2 test suite does not catch it because its adapter tests
use fake descriptors and never construct a real `FacenetModel`.
