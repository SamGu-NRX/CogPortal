# Architecture and trust boundary

The capstone asks students to build a facial-recognition application and a
Whispers clustering implementation. The benchmark therefore stays outside the
student application's architecture and observes only the behaviors described
by the [facial-recognition capstone][recognition] and [Whispers assignment][whispers].

Two `cogworks.submissions.v2` factories receive the course-owned FaceNet model.
The recognition adapter enrolls opaque person labels and returns a label or
`None` for each one-face RGB array. The clustering adapter returns an arbitrary
string or integer cluster label for each array. Cluster names have no meaning.

This boundary deliberately does not require `Profile`, `Database`, `Node`,
pickle files, a result dictionary, or a specific module layout. Reynaldo's
original broad `FaceRecognitionApp` methods remain a bounded compatibility
surface, but the benchmark never guesses how an unfamiliar method should map.
Its error reports the methods it found and points to `benchmark_adapter.py`.

The benchmark creates a fresh adapter for each scenario. A recognition scenario
retains that one adapter across initial enrollment, known queries, unknown
rejection, enrollment of the new identity, and held-out re-identification. This
makes database updates observable without prescribing how they are implemented.

## Repository layers

The two original projects retain separate responsibilities:

- `face_recognition_app` is Reynaldo's complete, documented class-based
  reference. It is a golden submission for direct, CLI, hosted, portal, and
  Discord integration tests.
- `facial_recognition_benchmark` contains both the original component
  diagnostics and the trusted v2 behavioral runner. Diagnostics such as the
  reference cosine-distance and synthetic database checks remain useful, but
  they are explicitly outside leaderboard scoring.

The future forkable student template remains a separate repository concern; it
must not replace the working reference application here. The test suite also
contains a function-oriented fixture modeled after the 2024 `FaceRecognizer`
project. It verifies that two substantially different application structures
receive the same scores through thin adapters.

This layering preserves the course's documented `Profile`, `Database`, and
`Node` examples while keeping official evaluation behavioral. It also records
the transcript decisions to verify the complete integrated path jointly and on
macOS and Windows in addition to Linux.

[recognition]: https://rsokl.github.io/CogWeb/Video/FacialRecognition.html
[whispers]: https://rsokl.github.io/CogWeb/Video/Whispers.html
