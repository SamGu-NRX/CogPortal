import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router";
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
  const [searchParams] = useSearchParams();
  const [discordToken, setDiscordToken] = useState<string | null>(() => fragmentToken());
  const [deviceName, setDeviceName] = useState("CogBench CLI");
  const [deviceApproved, setDeviceApproved] = useState(false);
  const preview = useDiscordLinkPreview(discordToken);
  const confirmDiscord = useConfirmDiscordLink();
  const unlinkDiscord = useUnlinkDiscord();
  const approveDevice = useApproveDevice();
  const revokeDevice = useRevokeDevice();
  const userCode = useMemo(() => searchParams.get("user_code")?.toUpperCase() ?? null, [searchParams]);

  useEffect(() => {
    if (!discordToken) return;
    const onHashChange = () => setDiscordToken(fragmentToken());
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, [discordToken]);

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
        GitHub is your account identity. Discord and CogBench connect to it without receiving your
        GitHub token or permission to submit official results.
      </p>

      {discordToken && (
        <Panel label="DISCORD REQUEST" className="mt-8 border-detect/35 bg-detect-wash">
          {preview.isPending ? (
            <LoadingMark label="Checking Discord request" />
          ) : preview.isError ? (
            <div role="alert">
              <p className="text-[14px] text-detect-deep">
                {errorMessage(preview.error, "This Discord request cannot be used.")}
              </p>
              <Button className="mt-4" variant="quiet" onClick={clearDiscordToken}>
                Dismiss
              </Button>
            </div>
          ) : (
            <div>
              <h2 className="text-xl">Link Discord account {preview.data.username}?</h2>
              <p className="mt-2 text-[13px] text-ink-secondary">
                The course bot will be able to show this account your team’s status and synced local
                reports. It cannot access your source code or start an official evaluation.
              </p>
              <div className="mt-5 flex flex-wrap gap-2">
                <Button
                  busy={confirmDiscord.isPending}
                  onClick={() =>
                    confirmDiscord.mutate(discordToken, {
                      onSuccess: clearDiscordToken,
                    })
                  }
                >
                  Link Discord
                </Button>
                <Button variant="quiet" onClick={clearDiscordToken}>
                  Cancel
                </Button>
              </div>
              {confirmDiscord.error && (
                <p role="alert" className="mt-3 text-[13px] text-detect-deep">
                  {errorMessage(confirmDiscord.error, "Discord could not be linked.")}
                </p>
              )}
            </div>
          )}
        </Panel>
      )}

      {userCode && !deviceApproved && (
        <Panel label="COGBENCH DEVICE" className="mt-8 border-verify/35 bg-verify-wash">
          <h2 className="text-xl">Approve device {userCode}</h2>
          <p className="mt-2 text-[13px] text-ink-secondary">
            This grants one device permission to upload explicitly selected local reports. It does not
            grant repository access or permission to run or promote benchmarks.
          </p>
          <form
            className="mt-5 max-w-sm"
            onSubmit={(event) => {
              event.preventDefault();
              approveDevice.mutate(
                { userCode, deviceName },
                {
                  onSuccess: () => {
                    clearConnectionReturn();
                    setDeviceApproved(true);
                  },
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
                {errorMessage(approveDevice.error, "The device could not be approved.")}
              </p>
            )}
          </form>
        </Panel>
      )}

      {deviceApproved && (
        <div role="status" className="mt-8 border-l-2 border-verify bg-verify-wash px-4 py-3 text-[14px] text-verify-deep">
          Device approved. Return to the terminal to finish linking.
        </div>
      )}

      <div className="mt-8 space-y-4">
        <Panel label="GITHUB">
          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="font-mono text-[13px] text-ink">{connections.data.github.login}</p>
              <p className="mt-1 text-[12px] text-ink-faint">Primary identity and sign-in</p>
            </div>
            <span className="font-mono text-[10.5px] text-verify-deep">VERIFIED</span>
          </div>
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
              Not linked. In the course server, run <code>/cog link</code> to begin.
            </p>
          )}
        </Panel>

        <Panel label="COGBENCH DEVICES">
          {connections.data.cliDevices.length === 0 ? (
            <p className="text-[13px] text-ink-secondary">
              No linked devices. Run <code>cogbench link</code> in your project when you want to sync a
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
