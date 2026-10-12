import { writeReceipt, type Receipt } from "../support/stack-info.ts";

/**
 * One journey case: a named run of real interactions whose every claim is
 * written down with the evidence that showed it. A case that cannot proceed
 * because the machine lacks something real (a course package, a dataset, an
 * interpreter) records BLOCKED — never a pass, never a silent skip.
 */
export class CheckFailure extends Error {}

/** Thrown by a case whose prerequisites are missing; the receipt says why. */
export class Blocked extends Error {}

type Claim = Receipt["claims"][number];

export class Case {
  private claims: Claim[] = [];
  private commands: NonNullable<Receipt["commands"]> = [];
  private blockedReason: string | undefined;

  constructor(
    readonly journey: string,
    readonly name: string,
    readonly touched: string[],
    private readonly options: { required?: boolean } = {},
  ) {}

  /** Whether the run bar treats this case as required (default: yes). */
  get required(): boolean {
    return this.options.required !== false;
  }

  /** Records an observation without judging it. */
  claim(claim: string, evidence: string): void {
    this.claims.push({ claim, evidence: clip(evidence) });
  }

  /** Records an observation that must hold; throws and fails the case if not. */
  expect(condition: boolean, claim: string, evidence: string): void {
    if (!condition) throw new CheckFailure(`${claim} — evidence: ${clip(evidence)}`);
    this.claim(claim, evidence);
  }

  /** Records a CLI or HTTP command the case ran, with its outcome. */
  command(args: string, exit: number | null, output: string): void {
    this.commands.push({ args, exit, output: clip(output) });
  }

  /** Ends the case early as BLOCKED: a real prerequisite is missing. */
  blocked(reason: string): never {
    this.blockedReason = reason;
    throw new Blocked(reason);
  }

  async run(body: () => Promise<void>): Promise<Receipt["status"]> {
    let status: Receipt["status"] = "PASS";
    try {
      await body();
    } catch (error) {
      if (error instanceof Blocked) {
        status = "BLOCKED";
      } else {
        status = "FAIL";
        const detail = error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error);
        this.claims.push({ claim: "case failed", evidence: clip(detail) });
      }
    }
    // A case that ran no command and asserted nothing cannot be judged PASS:
    // a PASS receipt without bound evidence of a real executed command is
    // exactly the phantom the receipts exist to prevent, so it records
    // BLOCKED with the reason instead. A claims-only case stays PASS — its
    // claims carry the evidence.
    if (status === "PASS" && this.commands.length === 0 && this.claims.length === 0) {
      status = "BLOCKED";
      this.blockedReason = "the case ran no command and asserted nothing; it cannot be judged PASS";
    }
    const receipt: Receipt = {
      journey: this.journey,
      case: this.name,
      status,
      claims: this.claims,
      touched: [...this.touched],
      commands: this.commands,
      ...(status === "BLOCKED" ? { blockedReason: this.blockedReason ?? "unrecorded" } : {}),
      // Under the pin matrix every receipt says which staging pin the CLI
      // came from; outside it the variables are unset and the field is
      // omitted, as the plan's cases run against this checkout's source.
      ...(pinFromEnvironment() ? { pin: pinFromEnvironment() } : {}),
      required: this.required,
    };
    await writeReceipt(receipt);
    if (status !== "PASS") process.exitCode = 1;
    return status;
  }
}

function clip(text: string, limit = 4000): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}… [${text.length - limit} more characters]`;
}

/**
 * The staging pin this run's CLI came from, when the pin matrix set one. All
 * three variables travel together; a partial set is a matrix bug and names
 * itself here rather than letting a receipt carry an unlabeled pin.
 */
function pinFromEnvironment(): Receipt["pin"] | undefined {
  const { PIN_ID: id, PIN_REV: revision, PIN_SOURCE: source } = process.env;
  if (!id && !revision && !source) return undefined;
  if (!id || !revision || !source) {
    throw new Error(`pin matrix set only part of PIN_ID/PIN_REV/PIN_SOURCE: ${id ?? "-"} / ${revision ?? "-"} / ${source ?? "-"}`);
  }
  return { id, revision, source };
}
