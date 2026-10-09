// Declared contract for the runtime payloads in command-payloads.mjs. That file
// is plain JavaScript and is not type-checked (the tsconfig sets no allowJs), so
// this declaration is the machine-checked statement of the shapes Discord
// expects; runtime enforcement of the same shapes lives in the payload
// validator.

/**
 * Values accepted by the /cog `view` option. A typo such as "homee" is a type
 * error here instead of a silent mismatch against Discord.
 */
type CogViewValue = "home" | "leaderboard" | "benchmarks" | "local" | "connect";

interface CogViewChoice {
  name: string;
  value: CogViewValue;
}

interface CogViewOption {
  /** Discord ApplicationCommandOptionType.STRING. */
  type: 3;
  name: "view";
  description: string;
  required: false;
  choices: CogViewChoice[];
}

/** Chat input command, Discord ApplicationCommandType.CHAT_INPUT. */
export interface ChatCommandPayload {
  type: 1;
  name: string;
  description: string;
  /** Exactly one option: the optional `view` picker with fixed choices. */
  options: [CogViewOption];
}

/** Entry point command, Discord ApplicationCommandType.PRIMARY_ENTRY_POINT. */
export interface EntryPointCommandPayload {
  type: 4;
  name: string;
  description: string;
  /** Discord EntryPointCommandHandlerType.APP_HANDLER: reply with LAUNCH_ACTIVITY. */
  handler: 1;
  /** Guild install (0) or user install (1). */
  integration_types: Array<0 | 1>;
  /** Guild (0), bot DM (1), or private channel (2). */
  contexts: Array<0 | 1 | 2>;
}

export type CommandPayload = ChatCommandPayload | EntryPointCommandPayload;

export declare const cogCommand: ChatCommandPayload;
export declare const entryPointCommand: EntryPointCommandPayload;
