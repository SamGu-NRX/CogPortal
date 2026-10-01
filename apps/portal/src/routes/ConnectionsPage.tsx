import { Tick02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { CornerBrackets } from "@/components/Brackets";
import { Button } from "@/components/Button";
import { ConfirmButton } from "@/components/ConfirmButton";
import { CopyBlock } from "@/components/CopyBlock";
import { LoadingMark, QueryError } from "@/components/Feedback";
import { Annotated, PageHeader } from "@/components/Note";
import { Panel } from "@/components/Panel";
import { ApiRequestError } from "@/lib/api";
import { formatDateTime } from "@/lib/format";
import { deviceLinkCommand } from "@/lib/setup-progress";
import {
  useApproveDevice,
  useConfirmDiscordLink,
  useConnections,
  useDiscordLinkPreview,
  useRevokeDevice,
  useUnlinkDiscord,
} from "@/lib/queries";
import { clearConnectionReturn } from "@/lib/pending-return";

function fragmentToken(): string | null {
  const params = new URLSearchParams(window.location.hash.slice(1));
  return params.get("discord");
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof ApiRequestError ? error.message : fallback;
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
  const [searchParams, setSearchParams] = useSearchParams();
  const [discordToken, setDiscordToken] = useState<string | null>(() => fragmentToken());
  const [linkedDiscord, setLinkedDiscord] = useState<string | null>(null);
  const [deviceName, setDeviceName] = useState("CogWorks CLI");
  const [deviceApproved, setDeviceApproved] = useState(false);
  const preview = useDiscordLinkPreview(discordToken);
  const confirmDiscord = useConfirmDiscordLink();
  const unlinkDiscord = useUnlinkDiscord();
  const approveDevice = useApproveDevice();
  const revokeDevice = useRevokeDevice();
  const userCode = useMemo(() => searchParams.get("user_code")?.toUpperCase() ?? null, [searchParams]);
  const returnToSetup = searchParams.get("return_to") === "setup";

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
    clearConnectionReturn();
    window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
    setDiscordToken(null);
  };

  const { github, discord, cliDevices } = connections.data;

  return (
    <div className="page anim-rise">
      <PageHeader
        eyebrow="Your account"
        title="Connections"
        lede="GitHub is who you are here. Discord and the CogWorks tool connect to that account without ever receiving your GitHub token, and neither can submit an official result."
      />

      {discordToken && (
        <Panel
          label={preview.isSuccess ? `Connect ${preview.data.username} to Cog?` : "Discord request"}
          description={
            preview.isSuccess
              ? "Cog can privately show this account your team's status and synced local reports. A leaderboard is shared to a channel only when you choose to share it."
              : undefined
          }
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
              <p className="text-[13.5px] leading-[1.55] text-ink-faint">
                Cog receives neither source code nor your GitHub token, and it can't start an
                official evaluation.
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
          <p className="text-[14px] leading-[1.6] text-ink-secondary">
            Cog is now connected to <strong className="font-semibold text-ink">{linkedDiscord}</strong>.
            Discord is still showing what it knew before you linked, so choose{" "}
            <strong className="font-semibold text-ink">Check the link</strong> in the Activity, or run{" "}
            <strong className="font-semibold text-ink">/cog</strong> again.
          </p>
        </Panel>
      )}

      {userCode && !deviceApproved && (
        <Panel
          label="Approve this device"
          description="It can upload the local reports you choose to sync. It gets no access to your repository and can't run or promote a benchmark."
          className="mt-10 max-w-[42rem]"
        >
          <p className="text-[14px] text-ink-secondary">
            Check that your terminal shows the same code before you approve it.
          </p>
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
              const onApproved = () => {
                clearConnectionReturn();
                setDeviceApproved(true);
                // Drop the code from the URL so a reload does not re-offer
                // the approval form for a code the server already consumed.
                const next = new URLSearchParams(searchParams);
                next.delete("user_code");
                setSearchParams(next, { replace: true });
                if (returnToSetup) {
                  window.setTimeout(() => navigate("/setup", { replace: true }), 900);
                }
              };
              approveDevice.mutate(
                { userCode, deviceName },
                {
                  onSuccess: onApproved,
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
            <p className="mt-1.5 text-[13px] text-ink-faint">
              So you can tell your machines apart in the list below.
            </p>
            <Button type="submit" className="mt-4" busy={approveDevice.isPending} disabled={!deviceName.trim()}>
              Approve device
            </Button>
            {approveDevice.error && (
              <p role="alert" className="mt-3 text-[13.5px] text-detect-deep">
                {errorMessage(approveDevice.error, "The device couldn't be approved. Try again.")}
              </p>
            )}
          </form>
        </Panel>
      )}

      {deviceApproved && (
        <div
          role="status"
          className="anim-rise mt-10 flex max-w-[42rem] items-start gap-3 rounded-r-surface border-l-2 border-verify bg-verify-wash px-4 py-3 text-[14px] text-verify-deep"
        >
          <HugeiconsIcon icon={Tick02Icon} size={17} strokeWidth={2} aria-hidden="true" className="mt-0.5 shrink-0" />
          <span>
            Device approved. You can return to the terminal
            {returnToSetup ? "; returning to Setup…" : "."}
          </span>
        </div>
      )}

      <div className="mt-12">
        <Connection
          title="GitHub"
          note="You sign in with GitHub, and it's how your team's repository knows who you are."
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
          note="Cog, the course bot, can show you your team's status and synced reports in private. A leaderboard reaches a channel only when you choose to share it."
        >
          {discord ? (
            <>
              <Row
                name={<span className="font-mono text-[14px]">{discord.username}</span>}
                meta={`Linked ${formatDateTime(discord.linkedAt)}`}
                action={
                  <ConfirmButton
                    label="Unlink"
                    confirmLabel="Confirm, Cog stops seeing your team"
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
              Not linked. In the course server, run{" "}
              <code className="font-mono text-[0.92em] text-ink">/cog</code> and Cog will send you a
              private link that brings you back here.
            </p>
          )}
        </Connection>

        <Connection
          title="CogWorks tool"
          last
          note={
            <>
              A linked device can report <code className="font-mono text-[0.88em] text-ink not-italic">check</code> results
              and upload a local report you choose to sync. It can't touch your repository or start a
              run.
            </>
          }
        >
          {cliDevices.length === 0 ? (
            <>
              <p className="text-[14px] leading-[1.6] text-ink-secondary">
                No devices linked yet. Run this from your project folder, then approve the code it
                prints.
              </p>
              {/* The complete command, not the bare verb. A fresh CLI has no saved
                  portal and refuses `cogworks link` outright, which used to send a
                  first-time student to Setup to find the rest of it. */}
              <CopyBlock className="mt-3" text={deviceLinkCommand(window.location.origin)} wrap />
              <p className="mt-3 text-[14px] text-ink-secondary">
                Don't have the tool yet?{" "}
                <Link to="/setup" className="u-link">
                  Setup
                </Link>{" "}
                has the whole sequence.
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

/** One kind of connection: a title, what it is for in the margin, and its
 *  current state. Separated by rules rather than boxed, because the three are
 *  one list of the same thing. */
function Connection({
  title,
  note,
  last = false,
  children,
}: {
  title: string;
  note: ReactNode;
  last?: boolean;
  children: ReactNode;
}) {
  return (
    <section className={`border-t border-rule pt-6 ${last ? "" : "pb-10"}`}>
      <h2 className="text-[21px] text-ink">{title}</h2>
      <Annotated note={note} className="mt-3">
        {children}
      </Annotated>
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
