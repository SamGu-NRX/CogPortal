export interface CommandPayload {
  type: number;
  name: string;
  description: string;
  handler?: number;
  integration_types?: number[];
  contexts?: number[];
  options?: Array<Record<string, unknown>>;
}

export const cogCommand: CommandPayload;
export const entryPointCommand: CommandPayload;
