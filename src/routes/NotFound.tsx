import { Link } from "react-router";
import { EmptyState } from "@/components/EmptyState";

export function NotFound() {
  return (
    <div className="anim-rise mx-auto w-full max-w-md py-16">
      <div className="border border-rule bg-paper-raised">
        <EmptyState message="404 — nothing detected at this address.">
          <Link
            to="/"
            className="u-pressable inline-flex min-h-11 items-center border border-rule px-5 font-mono text-[11.5px] tracking-[0.09em] text-ink uppercase hover:border-ink-secondary"
          >
            Back to start
          </Link>
        </EmptyState>
      </div>
    </div>
  );
}
