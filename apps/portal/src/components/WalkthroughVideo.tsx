import type { ReactNode } from "react";
import { CornerBrackets } from "./Brackets";
import { Veil } from "./Veil";

/**
 * `base` names the shared path for the versioned WebM, MP4, poster, and
 * captions defined by the onboarding-media runbook.
 */
export function WalkthroughVideo({
  base,
  title,
  caption,
  meta,
  transcript,
}: {
  base: string;
  title: string;
  caption?: string;
  meta?: string;
  transcript?: ReactNode;
}) {
  return (
    <figure className="mt-4">
      <div className="relative border border-rule bg-ink">
        <CornerBrackets inset={-1} />
        {/* Native controls on purpose: pause, scrub, captions, and fullscreen
            behave correctly with keyboard and screen readers for free. */}
        <video
          className="block aspect-video w-full"
          controls
          preload="none"
          playsInline
          poster={`${base}.webp`}
          aria-label={title}
        >
          <source src={`${base}.webm`} type="video/webm" />
          <source src={`${base}.mp4`} type="video/mp4" />
          <track kind="captions" src={`${base}.vtt`} srcLang="en" label="English" />
        </video>
      </div>
      {(caption || meta) && (
        <figcaption className="mt-2 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
          {caption && <span className="text-[12px] text-ink-faint">{caption}</span>}
          {meta && (
            <span className="font-mono text-[10.5px] tracking-[0.05em] text-ink-faint uppercase">
              {meta}
            </span>
          )}
        </figcaption>
      )}
      {transcript && (
        <div className="mt-2">
          <Veil count={1} moreLabel="Read the transcript" fewerLabel="Fold the transcript away">
            <div className="border border-rule-soft bg-paper-raised px-4 py-3 text-[13px] leading-relaxed text-ink-secondary">
              {transcript}
            </div>
          </Veil>
        </div>
      )}
    </figure>
  );
}
