// STAGE 3 — installed-client compatibility. Fill in (owner: client-compat sub-thread).
// Objective: the CLI students already installed (pip cogworks-benchmark @ the
// beta pin, i.e. commit 064400e) keeps working against alpha's Worker:
// link, sync, status, and run --live. And alpha's CLI works against beta's
// Worker, for the window when the two deploy out of step. Both directions need
// a result; wire defects get a failing witness committed under witnesses/
// (owned by the CLI task, PR #110) with the repro command.
// Pass bar: receipts/clients.json with per-direction, per-command results.
export async function run() {
  throw new Error("clients stage not implemented yet (client-compat sub-thread)");
}
process.argv[1]?.endsWith("clients.mjs") && run().catch((e) => { console.error(e); process.exit(1); });
