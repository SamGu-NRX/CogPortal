/**
 * Honesty marker: a result the fixture provider scripted must not read as a
 * real evaluation. Callers show it from the result's own `simulated` flag,
 * never from the deployment's current provider, so the mark stays with the
 * result after the provider changes and reaches signed-out readers too.
 *
 * The dashed rule is the tell: a pencil outline rather than an inked one, the
 * same way a notebook marks a value it did not measure. The reason is spoken,
 * not only hovered, because a title attribute never reaches a phone or a
 * screen reader.
 */
export function SimulatedChip() {
  return (
    <span
      title="Run by the fixture provider. Results are scripted, not real evaluation."
      className="inline-flex items-center rounded-control border border-dashed border-rule-strong px-2 py-0.5 text-[12.5px] font-semibold text-ink-secondary"
    >
      Simulated
      <span className="sr-only">: results here are scripted, not a real evaluation</span>
    </span>
  );
}
