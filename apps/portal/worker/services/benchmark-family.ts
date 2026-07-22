export type BenchmarkSource = {
  repositoryId: number | null;
  sha: string;
};

export type WeightedComponent = {
  value: number;
  weight: number;
};

export function hasSharedBenchmarkSource(sources: BenchmarkSource[]): boolean {
  const [first, ...rest] = sources;
  if (!first || first.repositoryId === null) return false;
  return rest.every(
    (source) =>
      source.repositoryId === first.repositoryId && source.sha === first.sha,
  );
}

export function weightedComponentScore(components: WeightedComponent[]): number {
  return components.reduce(
    (total, component) => total + component.value * component.weight,
    0,
  );
}
