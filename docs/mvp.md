# Dependable MVP scope

## Included now

- GitHub primary identity, immutable repository IDs, permission revalidation,
  and template-fork enforcement.
- Discord `/cog benchmarks`, `leaderboard`, `status`, `local`, `link`, and
  `unlink`, restricted to one configured course guild.
- Explicit Discord confirmation and revocation in CogPortal.
- CogBench `doctor`, `test`, `run`, `report`, optional device linking, and
  explicit minimal report sync.
- Versioned TypeScript and JSON runner contracts with golden fixtures.
- Hosted fixture execution plus gated Modal preparation/evaluation.
- Practice-to-official exact-artifact promotion, quota refunds, hidden-label
  isolation, explicit leaderboard selection, and official log suppression.
- Scheduled stale-run reconciliation and expiring authorization cleanup.

## Deliberately not included

- Starting, cancelling, or promoting official runs from Discord.
- Automatic DMs, role assignment, presence, or a public multi-guild bot.
- Streaming every phase to Discord; status is pull-based and quiet by default.
- Automatic upload of local results, source code, predictions, arbitrary logs,
  environments, or local datasets.
- Treating local scores as verified or leaderboard-eligible.
- Arbitrary repositories, mutable template-name trust, or template submodules.
- Instructor administration UI, dataset authoring UI, billing, or generalized
  plugin marketplaces.
- Notification delivery. Terminal events use an outbox so a later opt-in design
  can be reliable, but no messages are sent without channel and consent policy.

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
