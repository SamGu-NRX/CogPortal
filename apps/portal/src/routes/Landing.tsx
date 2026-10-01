import { ArrowRight01Icon, ArrowUpRight01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { CSSProperties, ReactNode } from "react";
import { Link, Navigate } from "react-router";
import { OFFICIAL_LIMIT, PRACTICE_LIMIT } from "@cogworks/contracts/schema";
import { buttonClass } from "@/components/Button";
import { CornerBrackets } from "@/components/Brackets";
import { GitHubIcon } from "@/components/GitHubIcon";
import { nextStagePath } from "@/App";
import { useSession } from "@/lib/queries";
import { pendingReturn } from "@/lib/pending-return";

/**
 * The front page says what a run gives back before it says how to get one.
 *
 * A signed-out visitor is usually a student who was just told to "sign in to
 * the portal" and is deciding how much of their afternoon this will take. The
 * page answers with the thing they'll actually receive: a sentence about what
 * their pipeline did, with a curve and a number under it. That example is the
 * argument of docs/design/the-instrument-not-the-judge.md made visible, so it
 * leads, and it is labeled as an example because nothing on it was measured.
 *
 * It cannot carry the setup commands: those need a clone URL and a track, and
 * a signed-out page has neither. They live on /setup, which knows both.
 */
export function Landing() {
  const { data: session } = useSession();
  const template = session?.auth.templateRepo ?? null;
  const saved = session?.user ? pendingReturn() : null;
  if (saved) return <Navigate to={saved} replace />;
  const next = session?.user ? nextStagePath(session) : null;

  return (
    <div className="page !max-w-[64rem]">
      <section className="grid items-center gap-x-16 gap-y-12 lg:grid-cols-[minmax(0,1fr)_25rem]">
        <div className="anim-rise">
          <p className="u-eyebrow">CogWorks 2026 capstone benchmark</p>
          <h1 className="mt-3 max-w-[16ch] text-[clamp(2.5rem,1.6rem+3.4vw,3.75rem)] text-ink">
            See how your capstone holds up as the problem gets harder.
          </h1>
          <div className="mt-8 flex flex-wrap items-center gap-3">
            {next ? (
              <Link to={next} className={buttonClass("primary", "px-6")}>
                {next === "/dashboard"
                  ? "Open your runs"
                  : next === "/admin"
                    ? "Open Admin"
                    : "Continue setting up"}
                <HugeiconsIcon icon={ArrowRight01Icon} size={16} strokeWidth={2} aria-hidden="true" />
              </Link>
            ) : (
              <Link to="/signin" className={buttonClass("primary", "px-6")}>
                <GitHubIcon />
                Sign in with GitHub
              </Link>
            )}
            <Link to="/leaderboard" className={buttonClass("quiet")}>
              See this year's results
            </Link>
          </div>
        </div>

        <Specimen />
      </section>

      <section aria-labelledby="how-it-goes" className="mt-24">
        <h2 id="how-it-goes" className="text-[26px] text-ink">
          How a capstone week goes
        </h2>
        {/* A real sequence, so it is numbered: each step needs the one before
            it. The last two are two ways to run rather than a ladder, and a
            hosted practice run does not wait on a local one. */}
        <ol className="mt-8 grid gap-x-10 gap-y-9 sm:grid-cols-2 lg:grid-cols-4">
          <Step n={1} title="Bring a repository">
            {template ? (
              <p>
                Fork{" "}
                <a
                  href={`https://github.com/${template}`}
                  target="_blank"
                  rel="noreferrer"
                  className="u-link font-mono text-[13px] break-all"
                >
                  {template}
                  <HugeiconsIcon
                    icon={ArrowUpRight01Icon}
                    size={12}
                    strokeWidth={1.8}
                    className="ml-0.5 inline-block align-[-0.1em]"
                    aria-hidden="true"
                  />
                  <span className="sr-only"> (opens GitHub)</span>
                </a>{" "}
                or use one your team already has.
              </p>
            ) : (
              <p>One GitHub repository per team. Every hosted run starts from it.</p>
            )}
          </Step>

          <Step n={2} title="Set up your machine">
            <p>The setup page has the exact commands for your track.</p>
          </Step>

          <Step n={3} title="Practice on your machine">
            <p>
              <code className="font-mono text-[13px] text-ink">cogworks run</code>{" "}
              uses the hosted scorer, as often as you like.
            </p>
          </Step>

          <Step n={4} title="Run it on ours">
            <p>
              {PRACTICE_LIMIT} practice runs and {OFFICIAL_LIMIT} official attempts
              per benchmark, from the commit you pushed. You choose which official
              result is shown.
            </p>
          </Step>
        </ol>
      </section>
    </div>
  );
}

function Step({ n, title, children }: { n: number; title: string; children: ReactNode }) {
  return (
    <li className="border-t border-rule-strong pt-4">
      <span aria-hidden="true" className="u-tnum font-serif text-[15px] font-semibold text-ink-faint italic">
        {n}.
      </span>
      <h3 className="mt-1 text-[19px] text-ink">
        <span className="sr-only">Step {n}: </span>
        {title}
      </h3>
      <div className="mt-2 text-[14.5px] leading-[1.6] text-ink-secondary">{children}</div>
    </li>
  );
}

/* ── The example run ───────────────────────────────────────────────────── */

/**
 * Week 1's "knee" from the gallery fixtures, with the sentence the Week 1
 * scorer writes for that shape. Hand-drawn in the same grammar as
 * components/SweepTrace.tsx: two rules, no grid, y pinned to 0..1.
 */
const EXAMPLE = {
  sentence:
    "Identification holds to a 20-song library, then falls off. The right song is still being found, so the vote is what gives way as the library grows.",
  axis: "songs in the library",
  points: [
    { x: 5, y: 0.9 },
    { x: 10, y: 0.88 },
    { x: 20, y: 0.85 },
    { x: 40, y: 0.42 },
    { x: 80, y: 0.21 },
  ],
  knee: 2,
};

const W = 360;
const H = 170;
const PAD = { top: 16, right: 12, bottom: 26, left: 30 };

function Specimen() {
  const pts = EXAMPLE.points;
  // Spaced by rank, not by value: the library doubles each step, and an even
  // spacing is how the course draws a doubling sweep.
  const px = (i: number) => PAD.left + (i / (pts.length - 1)) * (W - PAD.left - PAD.right);
  const py = (y: number) => PAD.top + (1 - y) * (H - PAD.top - PAD.bottom);
  const d = pts.map((p, i) => `${i ? "L" : "M"}${px(i).toFixed(1)},${py(p.y).toFixed(1)}`).join(" ");
  const knee = pts[EXAMPLE.knee];

  return (
    <figure
      className="anim-rise relative rounded-surface border border-rule bg-paper-raised p-6 shadow-[0_1px_0_rgb(27_31_36/0.04),0_18px_40px_-24px_rgb(27_31_36/0.25)]"
      style={{ "--rise-delay": "80ms" } as CSSProperties}
    >
      <figcaption className="flex items-baseline justify-between gap-3">
        <span className="u-label">What a run shows</span>
        <span className="rounded-full border border-rule px-2 py-0.5 text-[12px] font-semibold text-ink-secondary">
          Example
        </span>
      </figcaption>

      <p className="mt-3 font-serif text-[19px] leading-[1.42] text-ink">{EXAMPLE.sentence}</p>

      <div className="relative mt-5">
        <svg
          viewBox={`0 0 ${W} ${H}`}
          className="w-full overflow-visible"
          role="img"
          aria-label="Example trace: identification score against songs in the library, 0.90 at 5 songs, 0.85 at 20, then 0.21 at 80."
        >
          <line x1={PAD.left} y1={PAD.top} x2={PAD.left} y2={H - PAD.bottom} className="stroke-rule-strong" strokeWidth="1" />
          <line x1={PAD.left} y1={H - PAD.bottom} x2={W - PAD.right} y2={H - PAD.bottom} className="stroke-rule-strong" strokeWidth="1" />
          {[0, 0.5, 1].map((t) => (
            <text key={t} x={PAD.left - 7} y={py(t) + 3} textAnchor="end" className="fill-ink-faint font-mono" fontSize="9.5">
              {t.toFixed(1)}
            </text>
          ))}
          {pts.map((p, i) => (
            <text key={`x${p.x}`} x={px(i)} y={H - PAD.bottom + 15} textAnchor="middle" className="fill-ink-faint font-mono" fontSize="9.5">
              {p.x}
            </text>
          ))}
          <path d={d} pathLength={1} fill="none" className="specimen-trace stroke-ink" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
          {pts.map((p, i) => (
            <circle
              key={p.x}
              cx={px(i)}
              cy={py(p.y)}
              r="3"
              className="specimen-point fill-paper-raised stroke-ink"
              strokeWidth="1.5"
              style={{ "--i": i } as CSSProperties}
            />
          ))}
        </svg>
        {/* The knee, marked with the detection bracket: "the instrument is
            looking here". Positioned in percentages of the drawing so it
            stays on the point at any width. */}
        <span
          aria-hidden="true"
          className="specimen-knee absolute block size-[22px] -translate-x-1/2 -translate-y-1/2"
          style={{ left: `${(px(EXAMPLE.knee) / W) * 100}%`, top: `${(py(knee.y) / H) * 100}%` }}
        >
          <CornerBrackets size={6} thickness={1.5} className="text-detect" />
        </span>
        <span
          aria-hidden="true"
          className="specimen-knee absolute u-note text-[13.5px] whitespace-nowrap text-detect-deep"
          style={{ left: `calc(${(px(EXAMPLE.knee) / W) * 100}% + 16px)`, top: `calc(${(py(knee.y) / H) * 100}% - 30px)` }}
        >
          the knee
        </span>
      </div>

      <p className="mt-2 flex justify-between font-mono text-[12px] text-ink-faint">
        <span>{EXAMPLE.axis}</span>
        <span>identification score</span>
      </p>
    </figure>
  );
}
