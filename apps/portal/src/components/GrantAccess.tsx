import { ArrowUpRight01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useInstallations, useSession } from "@/lib/queries";

/**
 * The "why isn't my repository listed?" affordance. Its wording tracks the
 * real state: before the GitHub App is installed anywhere it asks you to
 * grant access; once it is installed, the calmer ask is to edit which
 * repositories the app can see. Renders nothing when GitHub isn't
 * configured; hides the installations line for dev-auth users (the endpoint
 * 403s without an OAuth token).
 */
export function GrantAccess({ hasRepos }: { hasRepos: boolean }) {
  const { data: session } = useSession();
  const configured = Boolean(session?.auth.githubConfigured && session.auth.appSlug);
  const installations = useInstallations(configured);

  if (!configured) return null;

  const installationAccounts = installations.data ?? [];
  const installed = installationAccounts.length > 0;
  const label = installed
    ? hasRepos
      ? "Missing a repository? Edit access on GitHub"
      : "The app is installed. Edit which repositories it can see"
    : hasRepos
      ? "Missing a repository? Grant access on GitHub"
      : "Grant repository access on GitHub";

  return (
    <div className="mt-3 space-y-1">
      <a
        href={`https://github.com/apps/${session!.auth.appSlug}/installations/new`}
        target="_blank"
        rel="noreferrer"
        className="inline-flex min-h-9 items-center gap-1.5 font-mono text-[11.5px] tracking-[0.07em] text-ink-secondary uppercase underline decoration-rule underline-offset-4 hover:text-ink hover:decoration-ink"
      >
        {label}
        <HugeiconsIcon icon={ArrowUpRight01Icon} size={13} strokeWidth={1.8} aria-hidden="true" />
      </a>
      {installed && (
        <p className="font-mono text-[11px] text-ink-faint">
          App installed for: {installationAccounts.map((installation) => installation.account).join(", ")}
        </p>
      )}
    </div>
  );
}
