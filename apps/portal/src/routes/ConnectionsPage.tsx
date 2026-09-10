import { useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { Button } from "@/components/Button";
import { LoadingMark, QueryError } from "@/components/Feedback";
import { Panel } from "@/components/Panel";
import { ApiRequestError } from "@/lib/api";
import { formatDateTime } from "@/lib/format";
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

  return (
    <div className="anim-rise mx-auto w-full max-w-2xl py-12 sm:py-14">
      <h1 className="text-3xl">Connections</h1>
      <p className="mt-2 max-w-xl text-[14px] text-ink-secondary">
        GitHub is your account identity. Discord and the CogWorks CLI connect to it without receiving
        your GitHub token or permission to submit official results.
      </p>

      {discordToken && (
        <Panel label="DISCORD REQUEST" className="mt-8 border-detect/35 bg-detect-wash">
          {preview.isPending ? (
            <LoadingMark label="Checking Discord request" />
          ) : preview.isError ? (
            <div role="alert">
              <p className="text-[14px] text-detect-deep">
                {errorMessage(preview.error, "This Discord request can't be used. Start a new connection from Discord.")}
              </p>
              <Button className="mt-4" variant="quiet" onClick={clearDiscordToken}>
                Dismiss
              </Button>
            </div>
          ) : (
            <div>
              <h2 className="text-xl">Connect {preview.data.username} to Cog?</h2>
              <p className="mt-2 text-[13px] text-ink-secondary">
                Cog can privately show this account your team’s status and synced local reports. A
                leaderboard is shared to a channel only when you choose to share it.
              </p>
              <p className="mt-3 border-l-2 border-rule pl-3 text-[12px] text-ink-faint">
                Cog receives neither source code nor your GitHub token. It can't start an official evaluation.
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
                <p role="alert" className="mt-3 text-[13px] text-detect-deep">
                  {errorMessage(confirmDiscord.error, "Discord couldn't be connected. Try again.")}
                </p>
              )}
            </div>
          )}
        </Panel>
      )}

      {linkedDiscord && (
        <Panel
          label="CONNECTION COMPLETE"
          tone="good"
          className="anim-rise mt-8"
          aside={<span aria-hidden="true" className="font-mono text-[11px] text-verify-deep">LINKED</span>}
        >
          <h2 className="text-xl">You’re connected.</h2>
          <p className="mt-2 max-w-lg text-[13px] text-ink-secondary">
            Cog is now connected to <strong className="font-medium text-ink">{linkedDiscord}</strong>.
            Discord is still showing what it knew before you linked, so choose{" "}
            <strong className="font-medium text-ink">Check the link</strong> in the Activity, or run{" "}
            <strong className="font-medium text-ink">/cog</strong> again.
          </p>
        </Panel>
      )}

      {userCode && !deviceApproved && (
        <Panel label="COGWORKS DEVICE" className="mt-8 border-verify/35 bg-verify-wash">
          <h2 className="text-xl">Approve device {userCode}</h2>
          <p className="mt-2 text-[13px] text-ink-secondary">
            This grants one device permission to upload explicitly selected local reports. It does not
            grant repository access or permission to run or promote benchmarks.
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
            <label htmlFor="device-name" className="block text-[13px] font-medium text-ink">
              Device name
            </label>
            <input
              id="device-name"
              value={deviceName}
              onChange={(event) => setDeviceName(event.target.value)}
              maxLength={80}
              className="mt-1 h-11 w-full border border-rule bg-paper-raised px-3 text-[16px] text-ink"
            />
            <Button type="submit" className="mt-4" busy={approveDevice.isPending} disabled={!deviceName.trim()}>
              Approve device
            </Button>
            {approveDevice.error && (
              <p role="alert" className="mt-3 text-[13px] text-detect-deep">
                {errorMessage(approveDevice.error, "The device couldn't be approved. Try again.")}
              </p>
            )}
          </form>
        </Panel>
      )}

      {deviceApproved && (
        <div role="status" className="mt-8 border-l-2 border-verify bg-verify-wash px-4 py-3 text-[14px] text-verify-deep">
          Device approved. You can return to the terminal
          {returnToSetup ? "; returning to Setup…" : "."}
        </div>
      )}

      <div className="mt-8 space-y-4">
        <Panel label="GITHUB">
          {connections.data.github ? (
            <div className="flex items-center justify-between gap-4">
              <div>
                <p className="font-mono text-[13px] text-ink">{connections.data.github.login}</p>
                <p className="mt-1 text-[12px] text-ink-faint">Primary identity and sign-in</p>
              </div>
              <span className="font-mono text-[10.5px] text-verify-deep">VERIFIED</span>
            </div>
          ) : (
            <p className="text-[13px] text-ink-secondary">
              No GitHub identity; development sign-ins don't carry one.
            </p>
          )}
        </Panel>

        <Panel label="DISCORD">
          {connections.data.discord ? (
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div>
                <p className="font-mono text-[13px] text-ink">{connections.data.discord.username}</p>
                <p className="mt-1 text-[12px] text-ink-faint">
                  Linked {formatDateTime(connections.data.discord.linkedAt)}
                </p>
              </div>
              <Button
                variant="quiet"
                busy={unlinkDiscord.isPending}
                onClick={() => unlinkDiscord.mutate()}
              >
                Unlink
              </Button>
            </div>
          ) : (
            <p className="text-[13px] text-ink-secondary">
              Not linked. In the course server, open <code>/cog</code> and Cog will offer a private
              connection link.
            </p>
          )}
        </Panel>

        <Panel label="COGWORKS CLI DEVICES">
          {connections.data.cliDevices.length === 0 ? (
            <p className="text-[13px] text-ink-secondary">
              No linked devices. Run <code>cogworks link</code> in your project when you want to sync a
              local report.
            </p>
          ) : (
            <ul className="divide-y divide-rule-soft">
              {connections.data.cliDevices.map((device) => (
                <li key={device.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                  <div>
                    <p className="text-[13px] font-medium text-ink">{device.name}</p>
                    <p className="mt-0.5 text-[11.5px] text-ink-faint">
                      {device.lastUsedAt
                        ? `Last used ${formatDateTime(device.lastUsedAt)}`
                        : `Linked ${formatDateTime(device.createdAt)}`}
                    </p>
                  </div>
                  <Button
                    variant="quiet"
                    busy={revokeDevice.isPending && revokeDevice.variables === device.id}
                    onClick={() => revokeDevice.mutate(device.id)}
                  >
                    Revoke
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>
    </div>
  );
}
