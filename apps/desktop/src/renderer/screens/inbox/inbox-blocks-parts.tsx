/**
 * The three blocks that carry no markdown and no people: labelled fields, a
 * trend line and a piece of code. The Inbox's pane and Intake's pane draw
 * them with these same elements, so a plugin's block looks the same in both.
 */
import type { JSX } from "react";
import type { CodeBlock, FieldsBlock, TrendBlock } from "@hercule/contract";
import "./inbox-blocks.css";

/** The trend's drawing space is 100 wide and 32 high. The line runs between the top margin and the baseline. */
const TREND_HEIGHT = 32;
const TREND_BASELINE = 30;
const TREND_ROOM = 26;

/** Renders a block's title as a quiet heading, or nothing when it has none. */
function BlockTitle({ title }: { readonly title: string | undefined }): JSX.Element | null {
  return title === undefined ? null : <h3>{title}</h3>;
}

/** Renders a fields block: its rows as a label and a value each. */
export function FieldsBlockView({ block }: { readonly block: FieldsBlock }): JSX.Element {
  return (
    <section className="bk">
      <BlockTitle title={block.title} />
      <dl className="bk-fields">
        {block.rows.map((row, index) => (
          // Two rows can share a label, and the rows never change order.
          <div key={index}>
            <dt>{row.label}</dt>
            <dd>{row.value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

/**
 * Returns the points of the trend's line in a 100 by 32 box: spread evenly
 * from left to right, and scaled so the highest value nearly touches the top.
 * A series of only zeros lies along the bottom.
 */
const buildTrendPoints = (points: TrendBlock["points"]): string => {
  const highest = Math.max(...points.map((point) => point.value));
  const step = 100 / (points.length - 1);
  return points
    .map((point, index) => {
      const height = highest === 0 ? 0 : (point.value / highest) * TREND_ROOM;
      return `${(index * step).toFixed(2)},${(TREND_BASELINE - height).toFixed(2)}`;
    })
    .join(" ");
};

const DAY_MS = 24 * 60 * 60 * 1000;

/** Returns how long before `now` a timestamp was, in whole days, as words: "today", "yesterday", "14 days ago". */
const describeDaysAgo = (timestamp: string, now: Date): string => {
  const days = Math.max(0, Math.round((now.getTime() - new Date(timestamp).getTime()) / DAY_MS));
  if (days === 0) return "today";
  return days === 1 ? "yesterday" : `${String(days)} days ago`;
};

/**
 * Renders a trend block: its caption, a line through its points with no
 * chart library, and under it how long ago the first point was and the last value. The
 * line's label says the caption and the last value, because the line itself
 * holds no words.
 */
export function TrendBlockView({
  block,
  now,
}: {
  readonly block: TrendBlock;
  /** The moment the dates under the line are counted back from. */
  readonly now: Date;
}): JSX.Element {
  const first = block.points[0]!;
  const last = block.points[block.points.length - 1]!;
  const lastValue = new Intl.NumberFormat("en").format(last.value);
  const firstWords = describeDaysAgo(first.at, now);
  const lastWords = `${lastValue} ${describeDaysAgo(last.at, now)}`;
  return (
    <section className="bk">
      <h3>{block.caption}</h3>
      <svg
        className="bk-trend"
        viewBox={`0 0 100 ${String(TREND_HEIGHT)}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={`${block.caption}, ${lastWords}`}
      >
        <polyline points={buildTrendPoints(block.points)} vectorEffect="non-scaling-stroke" />
      </svg>
      <p className="bk-axis" aria-hidden="true">
        <span>{firstWords}</span>
        <span>{lastWords}</span>
      </p>
    </section>
  );
}

/** Renders a code block: plain text in a box, with no highlighting, and a note when the producer cut it. */
export function CodeBlockView({ block }: { readonly block: CodeBlock }): JSX.Element {
  return (
    <section className="bk">
      <BlockTitle title={block.title} />
      <pre className="bk-code">{block.text}</pre>
      {block.truncated === true && <p className="bk-fine">Cut short.</p>}
    </section>
  );
}
