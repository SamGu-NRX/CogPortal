// Declaration for register-commands-lib.mjs, matching the command-payloads.d.mts idiom.
export declare class RegistrationError extends Error {
  constructor(message: string, options?: { cause?: unknown });
}

export interface RegisterCommandsOptions {
  env?: Record<string, string | undefined>;
  // The minimal fetch contract the lib calls with: a string URL and a plain
  // init object. The global fetch satisfies this structurally as well.
  fetchImpl?: (
    input: string,
    init: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal },
  ) => Promise<{ ok: boolean; status: number; text(): Promise<string>; json(): Promise<unknown> }>;
  log?: (line: string) => void;
}

export interface RegisterCommandsResult {
  entryPoint: string;
  guildCommandsReplaced: boolean;
}

export declare function registerCommands(options?: RegisterCommandsOptions): Promise<RegisterCommandsResult>;
