// STAGE 4 — migration failure cases. Fill in (owner: failure-cases sub-thread).
// Four scenarios, each with a committed witness and an outcome:
//   1. a migration interrupted halfway, then re-run to completion
//   2. migrations applied twice (including the deployed duplicate 0039/0040
//      file pairs — never renumber them)
//   3. alpha's Worker started before 0047-0049 apply
//   4. rollback: beta's Worker against a database that already ran alpha's
//      migrations (is beta's code still correct on the new columns?)
// Where a scenario proves a data-shape defect, the fix is an ADDITIVE
// migration under apps/portal/migrations/ (never renumber/delete existing).
// Pass bar: receipts/failures.json; every scenario has a witness + outcome
// (passes / fixed by additive migration / handed to owning task).
export async function run() {
  throw new Error("failures stage not implemented yet (failure-cases sub-thread)");
}
process.argv[1]?.endsWith("failures.mjs") && run().catch((e) => { console.error(e); process.exit(1); });
