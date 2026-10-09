export interface CommandPayloadIssue {
  path: string;
  message: string;
}

export const PAYLOAD_LIMITS: {
  nameMaxLength: number;
  descriptionMaxLength: number;
  maxOptions: number;
  maxChoices: number;
  choiceNameMaxLength: number;
  choiceValueMaxLength: number;
};

export declare class CommandPayloadValidationError extends Error {
  readonly errors: CommandPayloadIssue[];
  constructor(errors: CommandPayloadIssue[]);
}

export function validateCommandPayload(payload: unknown): unknown;
