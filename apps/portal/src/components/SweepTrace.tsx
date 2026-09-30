import { useEffect, useState } from "react";
import type { RunDetail } from "@cogworks/contracts/schema";

type Sweep = NonNullable<RunDetail["sweep"]>;

const HEIGHT = 170;
const PAD = { top: 12, right: 14, bottom: 26, left: 34 };

/**
 * The viewBox narrows on a narrow screen.
 *
 * An SVG with a fixed viewBox scales its type with the container, so a 9px
 * label drawn for a 520-unit box lands near 5px on a phone and cannot be
 * read. Fewer user units across means the same 9px occupies more of them, and
 * the label survives the downscale at roughly its intended size. The drawing
 * is unchanged; only how much room it is given is.
 */
function useTraceWidth(): number {
  const [width, setWidth] = useState(() =>
    typeof window === "undefined" || window.innerWidth >= 640 ? 520 : 320,
  );
  useEffect(() => {
    const query = window.matchMedia("(min-width: 640px)");
    const sync = () => setWidth(query.matches ? 520 : 320);
    sync();
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, []);
  return width;
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
 * Drawn by hand rather than with a chart library. Four points and two axes do
 * not need 40kB of JavaScript, and a library's defaults (gridlines, tooltips,
 * a legend, rounded everything) fight the notebook look that the rest of the
 * app holds.
 */
/**
 * What to print under a point.
 *
 * A sweep's x is usually a quantity and reads correctly as itself: Week 1's
 * is a count of songs. Week 3's is an ordering, the four query rewrites from
 * the caption unchanged to the furthest, so its x values are 0 through 3 and
 * say nothing. Those points carry a name, and it is the name a reader needs,
 * in the drawing and in the sentence read aloud.
 */
function tick(point: Sweep["points"][number]): string {
  return point.label ?? String(point.x);
}

export function SweepTrace({ sweep }: { sweep: Sweep }) {
  const WIDTH = useTraceWidth();
  const points = sweep.points;
  if (points.length < 2) return null;

  const xs = points.map((point) => point.x);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const spanX = maxX - minX || 1;

  // The y axis is pinned to 0..1 rather than fitted to the data. A fitted axis
  // makes a curve that fell from 0.54 to 0.52 look like a collapse, which is
  // exactly the misreading this component exists to prevent.
  const plotW = WIDTH - PAD.left - PAD.right;
  const plotH = HEIGHT - PAD.top - PAD.bottom;
  const px = (x: number) => PAD.left + ((x - minX) / spanX) * plotW;
  const py = (y: number) => PAD.top + (1 - Math.max(0, Math.min(1, y))) * plotH;

  const path = points.map((p, i) => `${i === 0 ? "M" : "L"}${px(p.x)},${py(p.y)}`).join(" ");
  const last = points[points.length - 1];

  return (
    // Capped rather than fluid. An SVG stretched to a wide container scales
    // its strokes and 9px labels with it, so a 1.75px trace lands at 2.9px and
    // reads heavier than every rule around it. At most its natural size.
    <figure className="mt-1" style={{ maxWidth: WIDTH }}>
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        className="w-full"
        role="img"
        aria-label={`${sweep.metric} against ${sweep.axis}, from ${points[0].y.toFixed(2)} at ${tick(points[0])} to ${last.y.toFixed(2)} at ${tick(last)}`}
      >
        {/* Two rules, no grid. The eye reads the shape, and the endpoints are
            labeled, so gridlines would only add ink. */}
        <line
          x1={PAD.left} y1={PAD.top} x2={PAD.left} y2={HEIGHT - PAD.bottom}
          className="stroke-rule" strokeWidth="1"
        />
        <line
          x1={PAD.left} y1={HEIGHT - PAD.bottom} x2={WIDTH - PAD.right} y2={HEIGHT - PAD.bottom}
          className="stroke-rule" strokeWidth="1"
        />
        {[0, 0.5, 1].map((tick) => (
          <text
            key={tick}
            x={PAD.left - 6} y={py(tick) + 3}
            textAnchor="end"
            className="fill-ink-faint font-mono"
            fontSize="9"
          >
            {tick.toFixed(1)}
          </text>
        ))}
        <path d={path} fill="none" className="stroke-ink" strokeWidth="1.75" />
        {points.map((point) => (
          <circle
            key={point.x}
            cx={px(point.x)} cy={py(point.y)} r="2.5"
            className="fill-paper stroke-ink" strokeWidth="1.25"
          />
        ))}
        {/* The value at each point, printed the way an instrument prints a
            reading beside its trace.
            
            This used to say a label per point turns the trace into a table
            and the table is already on the page. That was true while every
            plotted value was also a row. Week 3's rung values are now read
            here and nowhere else, and nobody can take a number off a 520-unit
            SVG by eye. A hover would not do: it is undiscoverable, it does
            nothing on a touch screen, and it is absent from the screenshot a
            student pastes into their writeup.
            
            Above the point, and only when the curve has room. Six points or
            fewer keeps the labels from colliding; beyond that the endpoints
            carry it as they did. */}
        {points.length <= 6 &&
          points.map((point) => (
            <text
              key={`v${point.x}`}
              x={px(point.x)}
              y={py(point.y) - 7}
              textAnchor="middle"
              className="fill-ink-faint font-mono"
              fontSize="8.5"
            >
              {point.y.toFixed(2)}
            </text>
          ))}
        {/* Only the ends are labeled. A label per point turns the trace into
            a table, and the table is already on the page. */}
        {[points[0], last].map((point, index) => (
          <text
            key={`x${index}`}
            x={px(point.x)}
            y={HEIGHT - PAD.bottom + 13}
            textAnchor={index === 0 ? "start" : "end"}
            className="fill-ink-faint font-mono"
            fontSize="9"
          >
            {tick(point)}
          </text>
        ))}
      </svg>
      <figcaption className="mt-1 flex items-baseline justify-between font-mono text-[11px] text-ink-faint">
        <span>{sweep.axis}</span>
        <span>{sweep.metric.replace(/_/g, " ")}</span>
      </figcaption>
    </figure>
  );
}
