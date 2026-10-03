/**
 * Honesty marker: while EXECUTION_PROVIDER is "fixture", run results are
 * scripted, and nothing on the page may let them read as a real evaluation.
 *
 * The dashed rule is the tell: a pencil outline rather than an inked one, the
 * same way a notebook marks a value it did not measure. The reason is spoken,
 * not only hovered, because a title attribute never reaches a phone or a
 * screen reader.
 */
export function SimulatedChip() {
  return (
    <span
      title="Execution provider is in fixture mode. Results are scripted, not real evaluation."
      className="inline-flex items-center rounded-control border border-dashed border-rule-strong px-2 py-0.5 text-[12.5px] font-semibold text-ink-secondary"
    >
      Simulated
      <span className="sr-only">: results here are scripted, not a real evaluation</span>
    </span>
  );
}
