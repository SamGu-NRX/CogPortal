/**
 * Hand-written type declarations paired with command-payloads.mjs.
 *
 * The payloads live as plain .mjs data, so this file is what lets tsc type
 * the import in test/commands.test.ts: with moduleResolution "bundler", the
 * .mjs specifier resolves to these declarations instead of untyped any.
 * Keep the export list in lockstep with the .mjs; every export there needs
 * a matching declaration here, under the same name and shape.
 *
 * CommandPayload.options is deliberately loose. Each option in the array is
 * a Record<string, unknown> because the two payloads use different option
 * shapes (a string select with choices versus no options at all), and
 * nothing here needs to introspect them; the tests assert on the top-level
 * fields only.
 */
export interface CommandPayload {
  /** Discord application command type: 1 chat input, 4 Activity Entry Point. */
  type: number;
  name: string;
  description: string;
  /** Interaction handler: 1 (APP_HANDLER) means the app handles the interaction itself. */
  handler?: number;
  /** Install targets: 0 guild install, 1 user install. */
  integration_types?: number[];
  /** Where the command can run: 0 guild, 1 bot DM, 2 private channel. */
  contexts?: number[];
  /** Discord command options, kept loose; see the interface comment above. */
  options?: Array<Record<string, unknown>>;
}

/** Guild /cog chat-input command; see command-payloads.mjs for the contract. */
export const cogCommand: CommandPayload;
/** Global launch Activity Entry Point command; see command-payloads.mjs for the contract. */
export const entryPointCommand: CommandPayload;
