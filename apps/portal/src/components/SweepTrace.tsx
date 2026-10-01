import { useEffect, useState } from "react";
import type { RunDetail } from "@cogworks/contracts/schema";
import { CornerBrackets } from "./Brackets";

type Sweep = NonNullable<RunDetail["sweep"]>;
type Point = Sweep["points"][number];

const HEIGHT = 190;
const PAD = { top: 26, right: 16, bottom: 28, left: 32 };

/**
 * The viewBox narrows on a narrow screen.
 *
 * An SVG with a fixed viewBox scales its type with the container, so a 9px
 * label drawn for a 560-unit box lands near 5px on a phone and cannot be
 * read. Fewer user units across means the same 9px occupies more of them, and
 * the label survives the downscale at roughly its intended size. The drawing
 * is unchanged; only how much room it is given is.
 */
function useTraceWidth(): number {
  const [width, setWidth] = useState(() =>
    typeof window === "undefined" || window.innerWidth >= 640 ? 560 : 330,
  );
  useEffect(() => {
    const query = window.matchMedia("(min-width: 640px)");
    const sync = () => setWidth(query.matches ? 560 : 330);
    sync();
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, []);
  return width;
}

/**
 * What to print under a point.
 *
 * A sweep's x is usually a quantity and reads correctly as itself: Week 1's
 * is a count of songs. Week 3's is an ordering, the four query rewrites from
 * the caption unchanged to the furthest, so its x values are 0 through 3 and
 * say nothing. Those points carry a name, and it is the name a reader needs,
 * in the drawing and in the sentence read aloud.
 */
function tick(point: Point): string {
  return point.label ?? String(point.x);
}

/**
 * The step the reader should look at: where the curve falls furthest between
 * two neighbouring points, marked on the point before the fall.
 *
 * Arithmetic on the measured values, not a reading of them. The benchmark's
 * finding says why the curve fell; this only says where. A fall under 0.1 is
 * not marked, so a gentle slope is not dressed up as a break: the gallery's
 * measured Week 1 reference falls 0.6 to 0.52 over four points (largest step
 * 0.0375) and should read as a slope, while its knee example falls 0.43 in
 * one step. The 0.1 sits between those two and is a judgment, not a measured
 * threshold; no study of real curves backs it.
 */
const MARKED_DROP = 0.1;
function largestDrop(points: Point[]): number | null {
  let at: number | null = null;
  let size = MARKED_DROP;
  for (let i = 0; i + 1 < points.length; i += 1) {
    const fall = points[i].y - points[i + 1].y;
    if (fall >= size) {
      size = fall;
      at = i;
    }
  }
  return at;
}

/**
 * The score against the benchmark's difficulty knob.
 *
 * The course teaches this measurement directly: grow the library and watch
 * where performance degrades. One number at one difficulty does not support
 * that method, and it also invites the reading the course argues against,
 * where a team is a position in an ordering. Two teams with the same final
 * number have visibly different curves, so the shape of this trace is the
 * part worth comparing.
 *
 * Drawn by hand rather than with a chart library. A few points and two axes
 * do not need 40kB of JavaScript, and a library's defaults (gridlines,
 * tooltips, a legend, rounded everything) fight the notebook. It shares the
 * front page's example trace (Specimen in routes/Landing.tsx): a 2px ink line,
 * round points on raised paper, two rules and no grid, y pinned to 0..1, and a
 * detection bracket with an italic note on the one point that matters.
 *
 * `previous` is the team's previous comparable run on the same axis, drawn
 * as a faint dashed line behind this one. It is the only comparison the page
 * makes, and it is with the team's own work.
 */
export function SweepTrace({
  sweep,
  previous = null,
  previousLabel,
}: {
  sweep: Sweep;
  previous?: Sweep | null;
  /** How the previous run is named in the key, e.g. "Run #D8DF". */
  previousLabel?: string;
}) {
  const WIDTH = useTraceWidth();
  const points = sweep.points;
  if (points.length < 2) return null;
  // Only a curve over the same knob and the same measure can share the axes.
  const ghost =
    previous &&
    previous.points.length >= 2 &&
    previous.axis === sweep.axis &&
    previous.metric === sweep.metric
      ? previous.points
      : null;

  const xs = [...points, ...(ghost ?? [])].map((point) => point.x);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  // A library that doubles (5, 10, 20, 40, 80) crowds its first points into
  // the left edge on a linear axis, which is where the curve usually holds.
  // The course draws a doubling sweep evenly spaced, which is a log axis. An
  // ordinal x (0..3) or a short range stays linear.
  const logX = minX > 0 && maxX / minX >= 8;
  const along = (x: number) => (logX ? Math.log(x) : x);
  const spanX = along(maxX) - along(minX) || 1;

  // The y axis is pinned to 0..1 rather than fitted to the data. A fitted axis
  // makes a curve that fell from 0.54 to 0.52 look like a collapse, which is
  // exactly the misreading this component exists to prevent.
  // The points sit inset from both rules, so the first value label clears
  // the y axis's "1.0" and the last one clears the right edge.
  const INSET = 16;
  const plotW = WIDTH - PAD.left - PAD.right - INSET * 2;
  const plotH = HEIGHT - PAD.top - PAD.bottom;
  const px = (x: number) => PAD.left + INSET + ((along(x) - along(minX)) / spanX) * plotW;
  const py = (y: number) => PAD.top + (1 - Math.max(0, Math.min(1, y))) * plotH;
  const path = (list: Point[]) =>
    list.map((p, i) => `${i === 0 ? "M" : "L"}${px(p.x).toFixed(1)},${py(p.y).toFixed(1)}`).join(" ");

  const last = points[points.length - 1];
  const marked = largestDrop(points);
  const markedPoint = marked === null ? null : points[marked];
  // Every point is labelled when the curve has room, the way the course
  // labels a short sweep; past six the labels collide, so the ends carry it.
  const roomy = points.length <= 6;
  const xTicks = roomy ? points : [points[0], last];

  // The label is the drawing for a screen reader, so it carries both curves.
  // With a previous run each series is named the way the key names it.
  const series = (list: Point[]) =>
    list.map((point) => `${point.y.toFixed(2)} at ${tick(point)}`).join(", ");
  const measure = `${sweep.metric.replace(/_/g, " ")} against ${sweep.axis}`;
  const fall = markedPoint ? ` The largest fall comes after ${tick(markedPoint)}.` : "";
  const spoken = ghost
    ? `${measure}. This run: ${series(points)}.${fall} ${
        previousLabel ?? "Previous run"
      }, before this one: ${series(ghost)}.`
    : `${measure}: ${series(points)}.${fall}`;

  return (
    // Capped rather than fluid. An SVG stretched to a wide container scales
    // its strokes and 9px labels with it, so a 2px trace lands at 3px and
    // reads heavier than every rule around it. At most its natural size.
    <figure style={{ maxWidth: WIDTH }}>
      <div className="relative">
        <svg
          viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
          className="w-full overflow-visible"
          role="img"
          aria-label={spoken}
        >
          {/* Two rules, no grid. The eye reads the shape, and the points are
              labeled, so gridlines would only add ink. */}
          <line
            x1={PAD.left} y1={PAD.top} x2={PAD.left} y2={HEIGHT - PAD.bottom}
            className="stroke-rule-strong" strokeWidth="1"
          />
          <line
            x1={PAD.left} y1={HEIGHT - PAD.bottom} x2={WIDTH - PAD.right} y2={HEIGHT - PAD.bottom}
            className="stroke-rule-strong" strokeWidth="1"
          />
          {[0, 0.5, 1].map((value) => (
            <text
              key={value}
              x={PAD.left - 7} y={py(value) + 3}
              textAnchor="end"
              className="fill-ink-faint font-mono"
              fontSize="9.5"
            >
              {value.toFixed(1)}
            </text>
          ))}
          {xTicks.map((point, index) => (
            <text
              key={`x${point.x}`}
              x={px(point.x)}
              y={HEIGHT - PAD.bottom + 15}
              // The ends hug the plot when only they are labelled, so a long
              // name does not run off the drawing.
              textAnchor={roomy ? "middle" : index === 0 ? "start" : "end"}
              className="fill-ink-faint font-mono"
              fontSize="9.5"
            >
              {tick(point)}
            </text>
          ))}

          {ghost && (
            <path
              d={path(ghost)}
              fill="none"
              className="stroke-ink-faint"
              strokeWidth="1.25"
              strokeDasharray="3 4"
              strokeLinejoin="round"
              strokeLinecap="round"
              opacity={0.7}
            />
          )}
          <path
            d={path(points)}
            fill="none"
            className="stroke-ink"
            strokeWidth="2"
            strokeLinejoin="round"
            strokeLinecap="round"
          />
          {points.map((point) => (
            <circle
              key={point.x}
              cx={px(point.x)} cy={py(point.y)} r="3"
              className="fill-paper-raised stroke-ink"
              strokeWidth="1.5"
            />
          ))}
          {/* The value at each point, printed the way an instrument prints a
              reading beside its trace. Week 3's rung values are read here and
              nowhere else, nobody can take a number off a curve by eye, and a
              hover would do nothing on a touch screen or in the screenshot a
              student pastes into their writeup. Beyond six points the labels
              collide, so the endpoints carry it. */}
          {(roomy ? points : [points[0], last]).map((point) => (
            <text
              key={`v${point.x}`}
              x={px(point.x)}
              // The marked point's bracket reaches 10 units up; its value sits
              // clear of it.
              y={py(point.y) - (point === markedPoint ? 15 : 8)}
              textAnchor="middle"
              className="u-tnum fill-ink-secondary font-mono"
              fontSize="9"
            >
              {point.y.toFixed(2)}
            </text>
          ))}
        </svg>
        {/* The point before the steepest fall, marked with the detection
            bracket: "the instrument is looking here". Positioned in
            percentages of the drawing so it stays on the point at any width.
            The note sits on whichever side has room. */}
        {markedPoint && (
          <>
            <span
              aria-hidden="true"
              className="absolute block size-[20px] -translate-x-1/2 -translate-y-1/2"
              style={{
                left: `${(px(markedPoint.x) / WIDTH) * 100}%`,
                top: `${(py(markedPoint.y) / HEIGHT) * 100}%`,
              }}
            >
              <CornerBrackets size={6} thickness={1.5} className="text-detect" />
            </span>
            <span
              aria-hidden="true"
              className={`u-note absolute text-[13.5px] whitespace-nowrap text-detect-deep ${
                px(markedPoint.x) / WIDTH > 0.6 ? "-translate-x-full" : ""
              }`}
              style={{
                left:
                  px(markedPoint.x) / WIDTH > 0.6
                    ? `calc(${(px(markedPoint.x) / WIDTH) * 100}% - 16px)`
                    : `calc(${(px(markedPoint.x) / WIDTH) * 100}% + 16px)`,
                // Above the point, as the front page sets it: the curve held
                // on the way in and falls on the way out, so the space above
                // is the space the line does not use.
                top: `calc(${(py(markedPoint.y) / HEIGHT) * 100}% - 30px)`,
              }}
            >
              falls off after here
            </span>
          </>
        )}
      </div>
      <figcaption className="mt-1.5 font-mono text-[12px] text-ink-faint">
        <span className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <span>{sweep.axis}</span>
          <span>{sweep.metric.replace(/_/g, " ")}</span>
        </span>
        {ghost && (
          <span className="mt-1.5 flex flex-wrap items-center gap-x-5 gap-y-1">
            <span className="inline-flex items-center gap-1.5">
              <svg aria-hidden="true" width="18" height="4" className="overflow-visible">
                <line x1="0" y1="2" x2="18" y2="2" className="stroke-ink" strokeWidth="2" />
              </svg>
              this run
            </span>
            <span className="inline-flex items-center gap-1.5">
              <svg aria-hidden="true" width="18" height="4" className="overflow-visible">
                <line x1="0" y1="2" x2="18" y2="2" className="stroke-ink-faint" strokeWidth="1.25" strokeDasharray="3 4" />
              </svg>
              {previousLabel ?? "previous run"}, before this one
            </span>
          </span>
        )}
      </figcaption>
    </figure>
  );
}
