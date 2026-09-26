# Exact case matrix

For the corpus operator. Every row is unmeasured. All commands below use the frozen source at portal `37b1972bbe17027256e1f5d9cf150e74193083e3` and the local311 environment specified in recipe.md. Run the commands from this directory. Replace `check` with `test` or `run` only after prerequisite and binding review.

Rows are grouped by week-project, 15 total. Vision lists two separate benchmark commands, making 20 pairs. Full SHA values and machine-readable columns are in cases.json.

## Week 1

| Group | Absolute cached repository and starting subdirectory | Commit | Benchmark/version and selected command | Prerequisite status |
| --- | --- | --- | --- | --- |
| 1 | `/Users/samgu/BWSI/2026/CogPortal/.cache/student-repos/rutvim2009__BWSI_CogWorks_Team_1/Week1` | `4329ed4deab53a39fc4ac876912863e04edc0403` | audio-identification v1: `bash run-case.sh w1-g1-audio check` | Local311 package files present; benchmark audio generated from pinned seeds. Ready for initial runtime check, not yet executed. |
| 2 | `/Users/samgu/BWSI/2026/CogPortal/.cache/student-repos/CogWorks-2026-Team-Asterisk__Week1-Capstone-Shazam` | `18e072c539f945c38c757c1646a8839a504e5e83` | audio-identification v1: `bash run-case.sh w1-g2-audio check` | Local311 package files present; benchmark audio generated from pinned seeds. Ready for initial runtime check, not yet executed. |
| 3 | `/Users/samgu/BWSI/2026/CogPortal/.cache/student-repos/Cog-gurts__Shazam-Project` | `1cc7570e159058cf770087003d854f8e6caf021b` | audio-identification v1: `bash run-case.sh w1-g3-audio check` | Local311 package files present; benchmark audio generated from pinned seeds. Ready for initial runtime check, not yet executed. |
| 4 | `/Users/samgu/BWSI/2026/CogPortal/.cache/student-repos/KrazeeCoder__week1-capstone-team4` | `71258046e60fecd3295c0b52236fc6e476b0e9cf` | audio-identification v1: `bash run-case.sh w1-g4-audio check` | Local311 package files present; benchmark audio generated from pinned seeds. Ready for initial runtime check, not yet executed. |
| 5 | `/Users/samgu/BWSI/2026/CogPortal/.cache/student-repos/carti4ce__week1_capstone` | `3f131ee526b8e079a24c83b5491ec6d21219fbda` | audio-identification v1: `bash run-case.sh w1-g5-audio check` | Local311 package files present; benchmark audio generated from pinned seeds. Ready for initial runtime check, not yet executed. |

## Week 2

| Group | Absolute cached repository and starting subdirectory | Commit | Benchmark/version and selected command | Prerequisite status |
| --- | --- | --- | --- | --- |
| 1 | `/Users/samgu/BWSI/2026/CogPortal/.cache/student-repos/rutvim2009__BWSI_CogWorks_Team_1/Week2` | `4329ed4deab53a39fc4ac876912863e04edc0403` | vision-clustering v2: `bash run-case.sh w2-g1-cluster check`<br>vision-recognition v2: `bash run-case.sh w2-g1-recognize check` | Local311 package files and verified FaceNet checkpoint present. Clustering discovery can be attempted; scoring needs the missing CelebA cache. Recognition has no automatic discovery at this pin. |
| 2 | `/Users/samgu/BWSI/2026/CogPortal/.cache/student-repos/CogWorks-2026-Team-Asterisk__Week2-Capstone` | `25b789c3aa59b89d7697ca405224554cea3fe9a3` | vision-clustering v2: `bash run-case.sh w2-g2-cluster check`<br>vision-recognition v2: `bash run-case.sh w2-g2-recognize check` | Local311 package files and verified FaceNet checkpoint present. Clustering discovery can be attempted; scoring needs the missing CelebA cache. Recognition has no automatic discovery at this pin. |
| 3 | `/Users/samgu/BWSI/2026/CogPortal/.cache/student-repos/Cog-gurts__CoggurtFilter` | `8b392da6224eaf5b875f1488c526e1868e9f27e0` | vision-clustering v2: `bash run-case.sh w2-g3-cluster check`<br>vision-recognition v2: `bash run-case.sh w2-g3-recognize check` | Local311 package files and verified FaceNet checkpoint present. Clustering discovery can be attempted; scoring needs the missing CelebA cache. Recognition has no automatic discovery at this pin. |
| 4 | `/Users/samgu/BWSI/2026/CogPortal/.cache/student-repos/LashikaKapoor28__Vision_Module_Capstone` | `479ad2c49a03a92e69d26415aa6d16a495f00d89` | vision-clustering v2: `bash run-case.sh w2-g4-cluster check`<br>vision-recognition v2: `bash run-case.sh w2-g4-recognize check` | Local311 package files and verified FaceNet checkpoint present. Clustering discovery can be attempted; scoring needs the missing CelebA cache. Recognition has no automatic discovery at this pin. |
| 5 | `/Users/samgu/BWSI/2026/CogPortal/.cache/student-repos/BagelBreaker__week2_capstone` | `29f9cf94751d6267e00be3ae4816be98a027662e` | vision-clustering v2: `bash run-case.sh w2-g5-cluster check`<br>vision-recognition v2: `bash run-case.sh w2-g5-recognize check` | Local311 package files and verified FaceNet checkpoint present. Clustering discovery can be attempted; scoring needs the missing CelebA cache. Recognition has no automatic discovery at this pin. |

## Week 3

| Group | Absolute cached repository and starting subdirectory | Commit | Benchmark/version and selected command | Prerequisite status |
| --- | --- | --- | --- | --- |
| 1 | `/Users/samgu/BWSI/2026/CogPortal/.cache/student-repos/rutvim2009__BWSI_CogWorks_Team_1/Week3` | `4329ed4deab53a39fc4ac876912863e04edc0403` | language-search v1: `bash run-case.sh w3-g1-language check` | Local311 package files present. Discovery and scoring blocked on missing caption, descriptor and GloVe artifacts plus derived KV cache. |
| 2 | `/Users/samgu/BWSI/2026/CogPortal/.cache/student-repos/CogWorks-2026-Team-Asterisk__Week3-Capstone` | `4ec78cf430ce21fe477cfa3f853cea5d53f02c8b` | language-search v1: `bash run-case.sh w3-g2-language check` | Local311 package files present. Discovery and scoring blocked on missing caption, descriptor and GloVe artifacts plus derived KV cache. |
| 3 | `/Users/samgu/BWSI/2026/CogPortal/.cache/student-repos/Cog-gurts__CogFinder` | `c10da68ccbf74110991e35de29ab6630a992421e` | language-search v1: `bash run-case.sh w3-g3-language check` | Local311 package files present. Discovery and scoring blocked on missing caption, descriptor and GloVe artifacts plus derived KV cache. |
| 4 | `/Users/samgu/BWSI/2026/CogPortal/.cache/student-repos/LashikaKapoor28__Language_Module_Capstone` | `8789361ad7dec86fa724431873f674e03b449951` | language-search v1: `bash run-case.sh w3-g4-language check` | Local311 package files present. Discovery and scoring blocked on missing caption, descriptor and GloVe artifacts plus derived KV cache. |
| 5 | `/Users/samgu/BWSI/2026/CogPortal/.cache/student-repos/BagelBreaker__week3_capstone` | `485d4f1f8e47311920980b06db97424ac97276f6` | language-search v1: `bash run-case.sh w3-g5-language check` | Local311 package files present. Discovery and scoring blocked on missing caption, descriptor and GloVe artifacts plus derived KV cache. |

## Per-case retained outputs

`local311/results/<id>/<phase>/stdout.json`, `stderr.log`, `exit-code.txt`, timestamps, command/cwd and Git status; successful writes to `.cogbench` are copied into that evidence directory. Read the full measurement contract in recipe.md before assigning a result category.

The table names source paths for identity. The wrapper runs only isolated copies, never those original paths. Source revisions are snapshots and the wrapper verifies the selected SHA before each command.
