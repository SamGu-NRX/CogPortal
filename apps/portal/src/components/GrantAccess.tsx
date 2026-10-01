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
    <div className="mt-3">
      <a
        href={`https://github.com/apps/${session!.auth.appSlug}/installations/new`}
        target="_blank"
        rel="noreferrer"
        className="u-link inline-flex min-h-11 items-center gap-1.5 text-[14px] font-semibold"
      >
        {label}
        <HugeiconsIcon icon={ArrowUpRight01Icon} size={14} strokeWidth={1.8} aria-hidden="true" />
        <span className="sr-only"> (opens GitHub)</span>
      </a>
      {installed && (
        <p className="text-[13px] text-ink-faint">
          Installed for{" "}
          <span className="font-mono text-[12.5px]">
            {installationAccounts.map((installation) => installation.account).join(", ")}
          </span>
        </p>
      )}
    </div>
  );
}
