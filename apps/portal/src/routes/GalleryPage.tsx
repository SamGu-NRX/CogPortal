import { Finding } from "@/components/Finding";
import { Panel } from "@/components/Panel";
import { PrimaryMetric, SupportingMetrics } from "@/components/MetricBlock";
import type { Metric } from "@cogworks/contracts/schema";

/**
 * Every state of the surfaces that are hard to reach, on one page.
 *
 * Some of these need a scored run against a specific failure, and producing
 * one on demand means either faking database rows or waiting for a team to
 * break their code in the right way. Neither is a reasonable way to look at a
 * sentence and decide whether it reads well.
 *
 * Dev only: the route is registered behind `import.meta.env.DEV`, so it does
 * not exist in a deployed bundle. The fixtures are hand-written rather than
 * generated, because the point is to look at the wording.
 */

function metric(over: Partial<Metric> = {}): Metric {
  return {
    key: "identification_score",
    label: "Identification score",
    value: 0.5312,
    precision: 4,
    unit: null,
    primary: true,
    higherIsBetter: true,
    help:
      "Top-1 accuracy over clips cut from songs you enrolled, after " +
      "perturbation. This is the leaderboard number.",
    ...over,
  } as Metric;
}

const SUPPORTING: Metric[] = [
  metric({ key: "clean_top1", label: "Clean top-1", value: 1.0, primary: false, help: null }),
  metric({ key: "noisy_top1", label: "Noisy top-1", value: 1.0, primary: false, help: null }),
  metric({
    key: "pitch_top1",
    label: "Pitch-shifted top-1",
    value: 0.0625,
    primary: false,
    help:
      "NOT part of the assignment. A shifted clip moves every peak to a " +
      "different frequency bin, so the stored keys stop matching.",
  }),
  metric({
    key: "catalog_knee",
    label: "Library size at the knee",
    value: 20,
    precision: 0,
    primary: false,
    help: "The library size where identification first drops 15 points below its best.",
  }),
];

const CASES: { title: string; note: string; sentence: string; supporting: string[] }[] = [
  {
    title: "The vote gives way",
    note: "The common shape. Fingerprints are fine, the tally is not.",
    sentence:
      "Identification holds to a 20-song library, then falls off. The right song " +
      "is still being found, so the vote is what gives way as the library grows.",
    supporting: [
      "20% of queries had the right song somewhere in the list but not near the top.",
      "Every clip from a song that was never enrolled still came back with a candidate.",
      "Weakest cell: pitch_-2 at 0% top-1.",
    ],
  },
  {
    title: "The fingerprints give way",
    note: "Different half of the pipeline, different fix.",
    sentence:
      "Identification holds to a 40-song library, then falls off, and at that " +
      "point most queries find no matching fingerprints at all. That is the " +
      "fingerprints rather than the vote.",
    supporting: [
      "94% of clips shared no fingerprints with anything the database stored.",
    ],
  },
  {
    title: "Nothing is size-limited",
    note: "The good answer. No knee metric is reported at all.",
    sentence:
      "Identification holds steady from 5 songs to 30, so nothing in the " +
      "pipeline is size-limited over this range.",
    supporting: [],
  },
  {
    title: "One note only",
    note: "Nothing below the rule. The figure must not leave a dangling border.",
    sentence:
      "Identification falls gradually from 60% at 5 songs to 52% at 30, without " +
      "a single point where it breaks.",
    supporting: [],
  },
  {
    title: "A long sentence",
    note: "Checks the 58ch measure holds and does not run to the window edge.",
    sentence:
      "Every clip from a song that was never enrolled still came back with a " +
      "candidate, and nothing in the assignment required an abstain path, so " +
      "this does not affect the score, but a minimum tally or a first-to-second " +
      "ratio is what would give you one.",
    supporting: ["A second note, for the rule.", "And a third."],
  },
];

export function GalleryPage() {
  return (
    <div className="mx-auto w-full max-w-4xl py-10">
      <h1 className="font-serif text-3xl font-semibold text-ink">Component gallery</h1>
      <p className="mt-2 max-w-prose text-[14px] text-ink-secondary">
        States that need a specific run to reach. Development only.
      </p>

      <h2 className="mt-10 font-serif text-xl font-semibold text-ink">Finding</h2>
      {CASES.map((example) => (
        <section key={example.title} className="mt-6">
          <div className="u-kicker">{example.title}</div>
          <p className="mb-2 text-[13px] text-ink-faint">{example.note}</p>
          <Panel>
            <Finding sentence={example.sentence} supporting={example.supporting} />
          </Panel>
        </section>
      ))}

      <h2 className="mt-12 font-serif text-xl font-semibold text-ink">
        Finding above results, as the run page composes them
      </h2>
      <Panel className="mt-4">
        <Finding sentence={CASES[0].sentence} supporting={CASES[0].supporting} />
      </Panel>
      <Panel label="RESULTS" className="mt-4">
        <div className="grid items-start gap-6 sm:grid-cols-2">
          <PrimaryMetric metric={metric()} />
          <SupportingMetrics metrics={SUPPORTING} />
        </div>
        <p className="mt-4 border-t border-rule-soft pt-3 font-mono text-[11px] text-ink-faint">
          Public practice split.
        </p>
      </Panel>
    </div>
  );
}
