# Fields read by the two process-signal builders

Declared by reading the sources on `fix/device-link-recovery-20261004`, then
verified by ablation (see `results/`). "Read" means a change to the field can
change at least one signal; "accepted, never read" means the builder takes the
field in and no function in the module consults it. Where the claim rests on
the source text plus a zero-delta ablation rather than an exhaustive proof,
the limitation is stated.

## `python/cogbench/src/cogbench/process.py`

Input types: `Commit`, `Run`. Stage maps and boundary files are caller-supplied
arguments (this study passes the module's own `DEFAULT_STAGE_MAPS[week]` and the
TS module's `BOUNDARY_FILES`, so the two arms read the same maps).

| Field | Read by | Role | Evidence |
|---|---|---|---|
| `Commit.sha` | `boundary_churn` (echo) | Echoed into `ChurnEvent.sha` only; cannot change classification or counts | source read |
| `Commit.author_login` | `stage_footprint`, `ownership_breadth`, `boundary_churn` | Author sets, distinct-author counts, churn attribution | source read; ablation `ablate-coauthor` (no-op in this arm) |
| `Commit.authored_at` | `stage_footprint`, `first_light`, `boundary_churn`, `_format_date` | First/last touch, run ordering, strictly-after churn comparison, date rendering | source read; ablation `ablate-timestamp` |
| `Commit.files_changed` | `classify_history_quality`, `stage_footprint`, `ownership_breadth`, `boundary_churn` | Bulk-upload share, stage matching, boundary matching | source read; ablation `ablate-filename` |
| `Commit.insertions` | — | **Accepted, never read.** The docstring says so; ablation `ablate-insertions` shows zero delta | source + ablation |
| `Commit.deletions` | — | **Accepted, never read.** Same | source + ablation |
| `Run.created_at` | `first_light` | Ordering of scored runs; earliest becomes `first_scored_at` | source read; ablation `ablate-scored-flag` |
| `Run.scored` | `first_light` | Filter for scored runs | source read; ablation `ablate-scored-flag` |
| `Run.run_id` | — | **Accepted, never read** by any signal function | source read; ablation `ablate-run-status` (delta-free pair) |
| `Run.status` | — | **Accepted, never read** | source read; ablation `ablate-run-status` |
| `coAuthors`-equivalent | — | **No such input exists.** A Python `Commit` carries exactly one `author_login`; trailers cannot be expressed. This is the declared TS-only capability | source read |

States the module cannot represent (by construction, no input produces them):
fetch failure, a truncated window, a week label it did not receive.

## `apps/portal/worker/services/process-signals.ts`

Input types: `CommitRecord`, `CoAuthorTrailer`, `FetchCommitsResult` (from
`../github/commits.ts`), `RunRecord`, `RosterMember`. Stage maps and boundary
files are module constants (`DEFAULT_STAGE_MAPS`, `BOUNDARY_FILES`).

| Field | Read by | Role | Evidence |
|---|---|---|---|
| `CommitRecord.sha` | `boundaryChurn` (echo) | Echoed into `ChurnEvent.sha` only | source read |
| `CommitRecord.authorLogin` | `stageFootprint`, `ownershipBreadth`, `boundaryChurn` | Author sets, counts, churn attribution | source read; ablations |
| `CommitRecord.authoredAt` (epoch ms) | `stageFootprint`, `firstLight`, `boundaryChurn`, `formatDate` | Same roles as Python's `authored_at` | source read; ablation `ablate-timestamp` |
| `CommitRecord.filesChanged` | `classifyHistoryQuality`, `stageFootprint`, `ownershipBreadth`, `boundaryChurn` | Bulk-upload share, stage matching, boundary matching | source read; ablation `ablate-filename` |
| `CommitRecord.coAuthors[].name/email` | `resolveCoAuthorLogin` → `commitAuthorLogins` | Trailer resolution against the roster; unresolved trailers are dropped, never guessed | source read; ablation `ablate-coauthor` (TS-only delta) |
| `FetchCommitsResult.ok` | `buildProcessSignals` | Failed fetch routes to the TS-only `fetch_failed` state | source read; scenario `week1-fetch-failed-unauthorized` |
| `FetchCommitsResult.truncated` | `buildProcessSignals`, sentence wording | Window reporting; qualifies absence claims | source read; scenario `week1-spread-usable` |
| `FetchCommitsResult.reason` | `historyUnavailableReason` | Chooses the unavailable-reason sentence | source read |
| `RunRecord.finishedAt` | `firstLight` | Ordering of scored runs | source read; ablation `ablate-scored-flag` |
| `RunRecord.scored` | `firstLight` | Filter for scored runs | source read; ablation `ablate-scored-flag` |
| `RunRecord.runId` | — | **Accepted, never read** by any signal function | source read; ablation `ablate-run-status` |
| `RosterMember.login` | `resolveCoAuthorLogin` | Canonical spelling of a resolved identity | source read |
| `RosterMember.email` | `resolveCoAuthorLogin` | Email-based trailer resolution | source read |

No `insertions`/`deletions` exist on `CommitRecord` at all — the fetch layer
never carries them (see `commits.ts` docstring), which is the stronger version
of Python's "accepted, never read".

TS-only output states with no Python counterpart: `historyQuality:
"fetch_failed"`, `historyWindow`, `runsElsewhere`, `weekLabel`, and the
difference that first light reads `finishedAt` where Python reads
`created_at` (the study maps the neutral `createdAt` to both).

## Fields deliberately absent from both arms' outputs

Per-person totals of any kind. `ownership_breadth`/`ownershipBreadth` emit
sorted name lists with no counts; `distinct_author_count` is a stage-wide
bus-factor number. The study commits no per-person scores or grades, and its
tests assert the serialized outputs expose no such field.
