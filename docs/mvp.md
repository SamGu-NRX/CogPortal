# Dependable MVP scope

## Included now

- GitHub primary identity, immutable repository IDs, permission revalidation,
  and template-fork enforcement.
- One state-aware Discord `/cog` surface for team status, benchmarks,
  leaderboard, local reports, and account linking, restricted to one configured course guild.
- Explicit Discord confirmation and revocation in CogPortal.
- CogBench `doctor`, `test`, `run`, `report`, optional device linking, and
  explicit minimal report sync.
- Explicit `cogbench run --live` projection into one mapped team-channel
  message, edited across a small local phase model and clearly labeled
  self-reported.
- Versioned TypeScript and JSON runner contracts with golden fixtures.
- Hosted fixture execution plus gated Modal preparation/evaluation.
- Practice-to-official exact-artifact promotion, quota refunds, hidden-label
  isolation, explicit leaderboard selection, and official log suppression.
- Scheduled stale-run reconciliation and expiring authorization cleanup.

## Deliberately not included

- Starting, cancelling, or promoting official runs from Discord.
- Automatic DMs, role assignment, presence, or a public multi-guild bot.
- Automatic or high-frequency Discord streaming. Live local projection is
  explicit, limited to four phase transitions, and uses one message per run.
- Automatic upload of local results, source code, predictions, arbitrary logs,
  environments, or local datasets.
- Treating local scores as verified or leaderboard-eligible.
- Arbitrary repositories, mutable template-name trust, or template submodules.
- Instructor administration UI, dataset authoring UI, billing, or generalized
  plugin marketplaces.
- Automatic DMs or broad notification delivery. Live local projection requires
  both an explicitly mapped team channel and `--live`; hosted terminal
  notifications remain a later opt-in design.

## Next gates, in order

1. Run Modal M0 with a malicious contract fixture and verify network denial,
   timeout, memory, archive, output, snapshot, retry, and refund behavior.
2. Finalize one real benchmark contract, public cases, hidden dataset, scorer,
   and canonical template repository with course owners.
3. Publish signed/versioned Python packages and test clean installs on supported
   student operating systems and Python versions.
4. Pilot with a small cohort using fixture mode first, then hosted practice.
5. Enable official evaluation only after instructors approve quota/refund and
   dataset policy.
6. Consider opt-in terminal notifications only after the status workflow is
   stable; consume the existing outbox rather than adding writes to run paths.
