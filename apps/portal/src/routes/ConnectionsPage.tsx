import { Tick02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, useLocation, useNavigate, useSearchParams } from "react-router";
import { CornerBrackets } from "@/components/Brackets";
import { Button } from "@/components/Button";
import { ConfirmButton } from "@/components/ConfirmButton";
import { CopyBlock } from "@/components/CopyBlock";
import { LoadingMark, QueryError } from "@/components/Feedback";
import { PageHeader } from "@/components/Note";
import { Panel } from "@/components/Panel";
import { ApiRequestError } from "@/lib/api";
import { useFocusFallback } from "@/lib/focus";
import { formatDateTime } from "@/lib/format";
import { deviceLinkCommand } from "@/lib/setup-progress";
import {
  useApproveDevice,
  useConfirmDiscordLink,
  useConnections,
  useDiscordLinkPreview,
  useRevokeDevice,
  useSession,
  useUnlinkDiscord,
} from "@/lib/queries";

function fragmentToken(): string | null {
  const params = new URLSearchParams(window.location.hash.slice(1));
  return params.get("discord");
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof ApiRequestError ? error.message : fallback;
}

type DeviceOutcome = {
  kind: "approved" | "refused";
  /** The code as submitted, or null when it is too long to show usefully. */
  shownCode: string | null;
};

/** Longer than any code the CLI prints; past it the sentence names no code. */
const SHOWN_CODE_LIMIT = 64;

/**
 * What the server said about the code this account just submitted, carried
 * on the history entry that answer created. Only this page writes it, after
 * the server's own response, so a typed URL can't produce one; and it
 * belongs to that entry, so a later visit, a new code or another account in
 * the tab doesn't see it. The state is still read as untrusted: anything
 * but the exact shape, for this account, reads as no outcome.
 *
 * The code itself is not checked against a pattern. The server accepts any
 * text, trimmed and upper-cased (contracts ApproveDeviceRequestSchema), and
 * refuses a malformed one with the same 410; a pattern here would discard
 * that real refusal and leave the reader with nothing. It is rendered as
 * text, and an oversized one is not printed at all.
 */
function deviceOutcomeFrom(state: unknown, login: string | undefined): DeviceOutcome | null {
  if (typeof state !== "object" || state === null || !login) return null;
  const { deviceOutcome } = state as Record<string, unknown>;
  if (typeof deviceOutcome !== "object" || deviceOutcome === null) return null;
  const { kind, code, login: outcomeFor } = deviceOutcome as Record<string, unknown>;
  if (outcomeFor !== login || (kind !== "approved" && kind !== "refused")) return null;
  if (typeof code !== "string" || code.length === 0) return null;
  return { kind, shownCode: code.length <= SHOWN_CODE_LIMIT ? code : null };
}

function refusalSentence(shownCode: string | null): string {
  return shownCode
    ? `The code ${shownCode} is invalid, expired, or already used, so it can't be approved.`
    : "That code is invalid, expired, or already used, so it can't be approved.";
}

/**
 * The accounts and machines attached to this person, and the two requests
 * that attach them: a Discord link from Cog and a device code from
 * `cogworks link`. A request, when one is in the address, is the page's one
 * decision and comes first; the standing connections sit below it.
 */
export function ConnectionsPage() {
  const connections = useConnections();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [discordToken, setDiscordToken] = useState<string | null>(() => fragmentToken());
  const [linkedDiscord, setLinkedDiscord] = useState<string | null>(null);
  const [deviceName, setDeviceName] = useState("CogWorks CLI");
  const location = useLocation();
  const login = useSession().data?.user?.login;
  const preview = useDiscordLinkPreview(discordToken);
  const confirmDiscord = useConfirmDiscordLink();
  const unlinkDiscord = useUnlinkDiscord();
  const approveDevice = useApproveDevice();
  const revokeDevice = useRevokeDevice();
  // Normalized once, the way the server reads it (trimmed, upper-cased), so
  // the code shown, sent and recorded is one value. A code that is only
  // whitespace is no code.
  const userCode = useMemo(() => searchParams.get("user_code")?.trim().toUpperCase() || null, [searchParams]);
  // The committed entry, read inside an approval's callbacks, which can run
  // after the page has moved to another entry, code or account. Written in a
  // layout effect so a render React throws away never becomes the target.
  const onScreen = useRef({ entry: location.key, search: location.search, code: userCode, login });
  useLayoutEffect(() => {
    onScreen.current = { entry: location.key, search: location.search, code: userCode, login };
  });
  // Who sent the attempt whose state may be shown; the mutation's variables
  // name the code but not the account.
  const [attemptBy, setAttemptBy] = useState<string | null>(null);
  // The attempt on screen is the mutation's latest, for this code and this
  // account. An earlier code still out doesn't make this one busy or show
  // its error here; its cleanup still runs in useApproveDevice.
  const attemptHere = approveDevice.variables?.userCode === userCode && attemptBy === (login ?? null);
  // A page-level "approved" flag used to outlive the code it described, so a
  // second code opened in the same visit got no form. The outcome lives on
  // the history entry instead (deviceOutcomeFrom); a code in the address
  // means a new request, and no outcome is shown over it.
  const outcome = userCode ? null : deviceOutcomeFrom(location.state, login);
  const returnToSetup = searchParams.get("return_to") === "setup";
  // Approving a device or connecting Discord replaces the request panel and
  // its focused button with a line saying it worked; focus goes to that line.
  const requestsRef = useRef<HTMLDivElement>(null);
  const keepRequestFocus = useFocusFallback(
    () => requestsRef.current?.querySelector<HTMLElement>("[data-request-outcome]"),
  );

  // The hop back to Setup belongs to the entry that says the device was
  // approved: opening another code or leaving the page cancels it. A timer
  // started in the approval callback ran whatever the reader had moved on to.
  const approvedHere = outcome?.kind === "approved";
  useEffect(() => {
    if (!approvedHere || !returnToSetup) return;
    const timer = window.setTimeout(() => navigate("/setup", { replace: true }), 900);
    return () => window.clearTimeout(timer);
  }, [approvedHere, returnToSetup, location.key, navigate]);

  useEffect(() => {
    const onHashChange = () => setDiscordToken(fragmentToken());
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  if (connections.isPending) return <LoadingMark label="Loading connections" />;
  if (connections.isError) {
    return (
      <div className="py-14">
        <QueryError error={connections.error} retry={() => void connections.refetch()} />
      </div>
    );
  }

  const clearDiscordToken = () => {
    window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
    setDiscordToken(null);
  };

  const { github, discord, cliDevices } = connections.data;

  return (
    <div className="page anim-rise">
      <PageHeader eyebrow="Your account" title="Connections" />

      <div ref={requestsRef} {...keepRequestFocus}>
        {/* Always mounted, so a refusal that arrives while the reader is
            elsewhere on the page is still read out; a status line that mounts
            with its text often isn't. Text only: the command to copy stays
            in the panel, outside the announcement. Focus moves to the panel
            only if it was lost with the form (useFocusFallback). */}
        <p role="status" className="sr-only" data-device-announcement="">
          {outcome?.kind === "refused"
            ? `${refusalSentence(outcome.shownCode)} Use the command below to request a fresh code.`
            : ""}
        </p>
        {discordToken && (
          <Panel
            label={preview.isSuccess ? `Connect ${preview.data.username} to Cog?` : "Discord request"}
            className="mt-10 max-w-[42rem]"
          >
            {preview.isPending ? (
              <LoadingMark label="Checking Discord request" />
            ) : preview.isError ? (
              <div role="alert">
                <p className="text-[14px] text-detect-deep">
                  {errorMessage(preview.error, "This Discord request can't be used. Start a new connection from Discord.")}
                </p>
                <Button className="mt-4" variant="ghost" onClick={clearDiscordToken}>
                  Dismiss
                </Button>
              </div>
            ) : (
              <div>
                {/* What the link grants, read off the bot's own actions
                    (apps/discord-bot/src/commands.ts, worker/rpc.ts). No promise
                    of a confirmation here: the Activity retries a failed run,
                    official ones included, without asking (RunConsole). */}
                <dl className="space-y-3 text-[14px] leading-[1.55]">
                  <div className="sm:grid sm:grid-cols-[9.5rem_minmax(0,1fr)] sm:gap-x-6">
                    <dt className="u-label text-ink">Shows you privately</dt>
                    <dd className="mt-0.5 text-ink-secondary sm:mt-0">
                      Your team's status and its synced local reports.
                    </dd>
                  </div>
                  <div className="sm:grid sm:grid-cols-[9.5rem_minmax(0,1fr)] sm:gap-x-6">
                    <dt className="u-label text-ink">Does as you</dt>
                    <dd className="mt-0.5 text-ink-secondary sm:mt-0">
                      Starts and retries hosted runs, spends official attempts and publishes
                      results to the public leaderboard, when you ask it to.
                    </dd>
                  </div>
                </dl>
                <p className="mt-4 text-[13.5px] leading-[1.55] text-ink-faint">
                  Cog never receives your source code or your GitHub token.
                </p>
                <div className="mt-5 flex flex-wrap gap-2">
                  <Button
                    busy={confirmDiscord.isPending}
                    onClick={() =>
                      confirmDiscord.mutate(discordToken, {
                        onSuccess: (summary) => {
                          setLinkedDiscord(summary.discord?.username ?? preview.data.username);
                          clearDiscordToken();
                        },
                      })
                    }
                  >
                    Connect Discord
                  </Button>
                  <Button variant="quiet" onClick={clearDiscordToken}>
                    Cancel
                  </Button>
                </div>
                {confirmDiscord.error && (
                  <p role="alert" className="mt-3 text-[13.5px] text-detect-deep">
                    {errorMessage(confirmDiscord.error, "Discord couldn't be connected. Try again.")}
                  </p>
                )}
              </div>
            )}
          </Panel>
        )}

        {linkedDiscord && (
          <Panel label="Discord connected" tone="good" className="anim-rise mt-10 max-w-[42rem]">
            <p data-request-outcome tabIndex={-1} className="text-[14px] leading-[1.6] text-ink-secondary">
              Cog is connected to <strong className="font-semibold text-ink">{linkedDiscord}</strong>.
              To refresh Discord, choose <strong className="font-semibold text-ink">Check the link</strong>{" "}
              in the Activity or run <strong className="font-semibold text-ink">/cog</strong> again.
            </p>
          </Panel>
        )}

        {userCode && (
          <Panel
            label="Approve this device"
            description="It sends check results, synced local reports and runs you share live. It can't touch your repository, start a hosted run or publish a result."
            className="mt-10 max-w-[42rem]"
          >
            <p className="text-[14px] text-ink-secondary">Approve only if your terminal shows this code.</p>
            {/* The code is what ties this page to one terminal, so it is shown
                big enough to compare at a glance, inside the bracket the portal
                uses for "look here". */}
            <p className="relative mt-3 inline-block px-4 py-3 font-mono text-[20px] leading-none tracking-[0.08em] whitespace-nowrap text-ink sm:px-5 sm:text-[26px] sm:tracking-[0.14em]">
              <CornerBrackets size={10} thickness={1.5} className="text-detect" />
              {userCode}
            </p>
            <form
              className="mt-5 max-w-sm"
              onSubmit={(event) => {
                event.preventDefault();
                if (approveDevice.isPending && attemptHere) return;
                const submitted = userCode;
                const submittedBy = login;
                const target = onScreen.current;
                setAttemptBy(submittedBy ?? null);
                // An answer ends this code on screen only while it is still
                // the code on screen, for the account that sent it: a late
                // answer for an earlier code must not take the current one's
                // form or address. Either way the code leaves the URL, so a
                // reload doesn't re-offer a form the server has answered, and
                // the answer rides on the replacing entry. The held link and
                // status are handled in useApproveDevice, which runs even if
                // this page has gone or moved on.
                // The same entry, not only the same code: reopening the link
                // makes a new entry, and an answer for the old one is not its.
                const stillOnScreen = () =>
                  Boolean(submittedBy) &&
                  onScreen.current.entry === target.entry &&
                  onScreen.current.code === submitted &&
                  onScreen.current.login === submittedBy;
                const settle = (kind: DeviceOutcome["kind"]) => {
                  if (!stillOnScreen()) return;
                  // From the committed entry's own search, not the one this
                  // callback was created with, so nothing else is lost.
                  const next = new URLSearchParams(onScreen.current.search);
                  next.delete("user_code");
                  const search = next.toString();
                  navigate(
                    { search: search ? `?${search}` : "" },
                    { replace: true, state: { deviceOutcome: { kind, code: submitted, login: submittedBy } } },
                  );
                };
                approveDevice.mutate(
                  { userCode: submitted, deviceName },
                  {
                    onSuccess: () => settle("approved"),
                    // Only the server's refusal ends the code. Any other
                    // failure leaves the form and its retry.
                    onError: (error) => {
                      if (!(error instanceof ApiRequestError && error.code === "link_expired")) return;
                      if (!stillOnScreen()) return;
                      settle("refused");
                      approveDevice.reset();
                    },
                  },
                );
              }}
            >
              <label htmlFor="device-name" className="u-label block">
                Device name
              </label>
              <input
                id="device-name"
                value={deviceName}
                onChange={(event) => setDeviceName(event.target.value)}
                maxLength={80}
                className="u-field mt-1.5"
              />
              <Button type="submit" className="mt-4" busy={approveDevice.isPending && attemptHere} disabled={!deviceName.trim()}>
                Approve device
              </Button>
              {/* Only this code's own attempt by this account; a failure for an
                  earlier code or another account would otherwise read as
                  this one's. */}
              {approveDevice.error && attemptHere && (
                <p role="alert" className="mt-3 text-[13.5px] text-detect-deep">
                  {errorMessage(approveDevice.error, "The device couldn't be approved. Try again.")}
                </p>
              )}
            </form>
          </Panel>
        )}

        {outcome?.kind === "refused" && (
          <Panel label="This code can't be approved" className="mt-10 max-w-[42rem]">
            <p data-request-outcome tabIndex={-1} className="text-[14px] leading-[1.6] text-ink-secondary [overflow-wrap:anywhere]">
              {outcome.shownCode ? (
                <>
                  The code <span className="font-mono text-ink">{outcome.shownCode}</span> is invalid, expired,
                  or already used, so it can't be approved.
                </>
              ) : (
                refusalSentence(null)
              )}
            </p>
            <p className="mt-3 text-[14px] leading-[1.6] text-ink-secondary">
              If that terminal is still waiting, Ctrl+C stops it. Run this in your project folder for a
              fresh code:
            </p>
            <CopyBlock className="mt-3" text={deviceLinkCommand(window.location.origin)} wrap />
            {cliDevices.length > 0 && (
              <p className="mt-3 text-[14px] text-ink-secondary">Your other linked devices are unchanged.</p>
            )}
          </Panel>
        )}

        {outcome?.kind === "approved" && (
          <div
            role="status"
            data-request-outcome
            tabIndex={-1}
            className="anim-rise mt-10 flex max-w-[42rem] items-start gap-3 rounded-r-surface border-l-2 border-verify bg-verify-wash px-4 py-3 text-[14px] text-verify-deep"
          >
            <HugeiconsIcon icon={Tick02Icon} size={17} strokeWidth={2} aria-hidden="true" className="mt-0.5 shrink-0" />
            <span>
              Device approved. You can return to the terminal
              {returnToSetup ? "; returning to Setup…" : "."}
            </span>
          </div>
        )}
      </div>

      <div className="mt-12">
        <Connection
          title="GitHub"
          grants="Discord and the CogWorks tool never receive your GitHub token."
        >
          {github ? (
            <Row
              name={<span className="font-mono text-[14px]">{github.login}</span>}
              meta={<span className="text-verify-deep">Verified by GitHub sign-in</span>}
            />
          ) : (
            <p className="text-[14px] text-ink-secondary">
              No GitHub identity; development sign-ins don't carry one.
            </p>
          )}
        </Connection>

        <Connection
          title="Discord"
          grants="When you use Cog, the course's Discord bot, it can start and retry hosted runs, spend official attempts and publish to the public leaderboard as you."
        >
          {discord ? (
            <>
              <Row
                name={<span className="font-mono text-[14px]">{discord.username}</span>}
                meta={`Linked ${formatDateTime(discord.linkedAt)}`}
                action={
                  <ConfirmButton
                    label="Unlink"
                    confirmLabel="Confirm, this account loses access"
                    onConfirm={() => unlinkDiscord.mutate()}
                    busy={unlinkDiscord.isPending}
                    className="px-4 !text-[13.5px]"
                  />
                }
              />
              {unlinkDiscord.error && (
                <p role="alert" className="mt-2 text-[13.5px] text-detect-deep">
                  {errorMessage(unlinkDiscord.error, "Discord couldn't be unlinked. Try again.")}
                </p>
              )}
            </>
          ) : (
            <p className="text-[14px] leading-[1.6] text-ink-secondary">
              Not linked. Run <code className="font-mono text-[0.92em] text-ink">/cog</code> in the
              course server to get a link.
            </p>
          )}
        </Connection>

        <Connection
          title="CogWorks tool"
          last
          grants="A linked device sends check results, synced local reports and runs you share live. It can't touch your repository or start a hosted run."
        >
          {cliDevices.length === 0 ? (
            <>
              <p className="text-[14px] leading-[1.6] text-ink-secondary">
                No devices linked. Run this in your project folder:
              </p>
              {/* The complete command, not the bare verb. A fresh CLI has no saved
                  portal and refuses `cogworks link` outright, which used to send a
                  first-time student to Setup to find the rest of it. */}
              <CopyBlock className="mt-3" text={deviceLinkCommand(window.location.origin)} wrap />
              <p className="mt-3 text-[14px] text-ink-secondary">
                Don't have the tool yet? Install it from{" "}
                <Link to="/setup" className="u-link">
                  Setup
                </Link>
                .
              </p>
            </>
          ) : (
            <ul role="list" className="divide-y divide-rule-soft border-y border-rule-soft">
              {cliDevices.map((device) => (
                <li key={device.id} className="py-3">
                  <Row
                    name={<span className="font-semibold">{device.name}</span>}
                    meta={
                      device.lastUsedAt
                        ? `Last used ${formatDateTime(device.lastUsedAt)}`
                        : `Linked ${formatDateTime(device.createdAt)}, not used yet`
                    }
                    action={
                      <ConfirmButton
                        label="Revoke"
                        confirmLabel="Confirm, it stops reporting"
                        onConfirm={() => revokeDevice.mutate(device.id)}
                        busy={revokeDevice.isPending && revokeDevice.variables === device.id}
                        className="px-4 !text-[13.5px]"
                      />
                    }
                  />
                  {revokeDevice.error && revokeDevice.variables === device.id && (
                    <p role="alert" className="mt-2 text-[13.5px] text-detect-deep">
                      {errorMessage(revokeDevice.error, "The device couldn't be revoked. Try again.")}
                    </p>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Connection>
      </div>
    </div>
  );
}

/** One kind of connection: a title, what it can and can't do, and its
 *  current state. Separated by rules rather than boxed, because the three are
 *  one list of the same thing. The permission line sits under the title so
 *  it is read before the control that grants or revokes it. */
function Connection({
  title,
  grants,
  last = false,
  children,
}: {
  title: string;
  grants: string;
  last?: boolean;
  children: ReactNode;
}) {
  // Revoking a device or unlinking Discord replaces the focused confirm with
  // the section's new state; the heading is where reading it starts.
  const headingRef = useRef<HTMLHeadingElement>(null);
  const keepFocus = useFocusFallback(() => headingRef.current);
  return (
    <section className={`max-w-[42rem] border-t border-rule pt-6 ${last ? "" : "pb-10"}`} {...keepFocus}>
      <h2 ref={headingRef} tabIndex={-1} className="text-[21px] text-ink">{title}</h2>
      <p className="mt-1 text-[13.5px] leading-[1.5] text-ink-faint">{grants}</p>
      <div className="mt-4">{children}</div>
    </section>
  );
}

function Row({ name, meta, action }: { name: ReactNode; meta: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
      <div className="min-w-0">
        <p className="text-[14.5px] text-ink">{name}</p>
        <p className="mt-0.5 text-[13px] text-ink-faint">{meta}</p>
      </div>
      {action}
    </div>
  );
}
