export declare class UsageError extends Error {}

export declare const WRANGLER_COMMANDS: readonly ["build", "deploy", "dev"];

export type WranglerCommand = (typeof WRANGLER_COMMANDS)[number];

export declare function resolveWranglerCommand(argv: readonly string[]): WranglerCommand;

export interface StagingDirectory {
  path: string;
  dispose(): void;
}

export declare function buildStagingDirectory(options: {
  appDirectory: string;
  tempRoot?: string;
}): StagingDirectory;

export declare function mapChildExit(options: {
  code?: number | null;
  signal?: string | null;
}): number;

export interface SignalTarget {
  kill(signal?: string | number): unknown;
}

export declare function forwardSignals(
  child: SignalTarget,
  signals?: readonly string[],
): () => void;
