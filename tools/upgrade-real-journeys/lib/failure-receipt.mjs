import { mkdirSync, writeFileSync } from "node:fs";

/**
 * Runs a stage's work and, when it fails, records why in the stage's receipt
 * before rethrowing the awaited error. A failed generation must still leave a
 * receipt: an absent file reads as "never ran", which hides real failures
 * behind teardown races. The original error is always rethrown; exit codes
 * and stderr stay authoritative. A receipt write that itself fails is
 * swallowed so it can never mask the error that caused it.
 *
 * @param {URL} receiptUrl - where the stage's receipt belongs
 * @param {() => Promise<unknown>} work - the stage's generation work
 */
export async function runWithFailureReceipt(receiptUrl, work) {
  try {
    return await work();
  } catch (error) {
    const reason = error instanceof Error ? (error.stack ?? error.message) : String(error);
    try {
      mkdirSync(new URL(".", receiptUrl), { recursive: true });
      writeFileSync(
        receiptUrl,
        `${JSON.stringify(
          { stage: "generate", status: "failed", error: reason, generatedAt: new Date().toISOString() },
          null,
          2,
        )}\n`,
      );
    } catch {
      // Never mask the original error with a receipt-write failure.
    }
    throw error;
  }
}
