/**
 * Honesty marker: while EXECUTION_PROVIDER is "fixture" (pre-M0), run results
 * are scripted — never let them read as real evaluation.
 */
export function SimulatedChip() {
  return (
    <span
      title="Execution provider is in fixture mode. Results are scripted, not real evaluation."
      className="border border-rule px-1.5 py-px font-mono text-[9.5px] font-medium tracking-[0.09em] text-ink-faint uppercase"
    >
      simulated
    </span>
  );
}
