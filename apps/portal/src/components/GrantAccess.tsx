import { ArrowUpRight01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useInstallations, useSession } from "@/lib/queries";

/**
 * Persistent "why isn't my repository listed?" affordance: the App-install
 * link plus which accounts have already granted access. Renders nothing when
 * GitHub isn't configured; hides the installations line for dev-auth users
 * (the endpoint 403s without an OAuth token).
 */
export function GrantAccess({ hasRepos }: { hasRepos: boolean }) {
  const { data: session } = useSession();
  const configured = Boolean(session?.auth.githubConfigured && session.auth.appSlug);
  const installations = useInstallations(configured);

  if (!configured) return null;

  return (
    <div className="mt-3 space-y-1">
      <a
        href={`https://github.com/apps/${session!.auth.appSlug}/installations/new`}
        target="_blank"
        rel="noreferrer"
        className="inline-flex min-h-9 items-center gap-1.5 font-mono text-[11.5px] tracking-[0.07em] text-ink-secondary uppercase underline decoration-rule underline-offset-4 hover:text-ink hover:decoration-ink"
      >
        {hasRepos ? "Missing a repository? Grant access on GitHub" : "Grant repository access on GitHub"}
        <HugeiconsIcon icon={ArrowUpRight01Icon} size={13} strokeWidth={1.8} aria-hidden="true" />
      </a>
      {installations.data && installations.data.length > 0 && (
        <p className="font-mono text-[11px] text-ink-faint">
          App installed for: {installations.data.map((i) => i.account).join(", ")}
        </p>
      )}
    </div>
  );
}
