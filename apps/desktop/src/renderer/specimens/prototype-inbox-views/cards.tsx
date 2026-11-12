/**
 * PROTOTYPE, throwaway. The core's one card. It draws any `CardFace` a plugin
 * declares (faces.ts) and never names a plugin or a kind, as spec 17 §Inbox ›
 * Cards requires. A face is plain data from a fixed vocabulary of parts, so a
 * plugin stays loosely coupled: it fills slots, it ships no UI.
 *
 * The card adds one thing itself: the time, from the External Entity. A real
 * time the source gave ("Thu 10:30", "in 2d") when there is one, otherwise
 * how long it has waited on you ("waiting 3h", bold once past its kind's
 * patience). Never a countdown the source did not give.
 */
import type { CSSProperties, JSX } from "react";
import "./cards.css";
import { readFace, type CardFace, type Glyph, type Part, type Tone } from "./faces";
import { Mark } from "./parts";
import { formatCount, formatWait, isPressing, type Thing } from "./world";

export type CardSize = "full" | "compact";

/** Draws a thing from the face its plugin declares, at `size`. */
export function ThingCard({
  thing,
  size = "full",
  selected = false,
  focused = false,
}: {
  readonly thing: Thing;
  readonly size?: CardSize;
  readonly selected?: boolean;
  readonly focused?: boolean;
}): JSX.Element {
  const face = readFace(thing);
  return (
    <article
      className={`cd is-${size}${thing.settled ? " is-settled" : ""}${selected ? " is-selected" : ""}${focused ? " is-focused" : ""}`}
      style={
        face.hue === undefined ? undefined : ({ "--cd-hue": String(face.hue) } as CSSProperties)
      }
      title={thing.reason}
    >
      <FaceView face={face} thing={thing} size={size} />
    </article>
  );
}

function FaceView({
  face,
  thing,
  size,
}: {
  readonly face: CardFace;
  readonly thing: Thing;
  readonly size: CardSize;
}): JSX.Element {
  return (
    <>
      <header className="cd-head">
        {face.glyph ? <GlyphIcon glyph={face.glyph} /> : <Mark source={thing.source} size={13} />}
        {face.top.map((p, i) => (
          <PartView key={i} part={p} />
        ))}
        <span className="cd-push" />
        {face.corner.map((p, i) => (
          <PartView key={i} part={p} />
        ))}
      </header>
      <p className={`cd-title${face.titleWeight === "regular" ? " is-regular" : ""}`}>
        {face.title}
      </p>
      {face.body && size === "full" ? (
        <p className={`cd-body is-${face.body.style}`}>{face.body.text}</p>
      ) : null}
      <footer className="cd-foot">
        {face.glyph ? <Mark source={thing.source} size={11} /> : null}
        {(size === "full" ? face.bottom : face.bottom.slice(0, 1)).map((p, i) => (
          <PartView key={i} part={p} />
        ))}
        <span className="cd-push" />
        <TimeView thing={thing} />
      </footer>
      {face.answers && size === "full" ? (
        <p className="cd-answers">
          {face.answers.map((a) => (
            <button key={a} type="button">
              {a}
            </button>
          ))}
        </p>
      ) : null}
    </>
  );
}

function readDateFromNow(minFromNow: number): Date {
  return new Date(Date.now() + minFromNow * 60_000);
}

/** Formats a time in minutes from now as the source would show it: "10:30" today, "Thu 10:30" later. */
export function formatClock(minFromNow: number): string {
  const d = readDateFromNow(minFromNow);
  const time = d.toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "UTC",
  });
  if (d.getUTCDate() === readDateFromNow(0).getUTCDate() && Math.abs(minFromNow) < 24 * 60)
    return time;
  return `${d.toLocaleDateString("en-GB", { weekday: "short", timeZone: "UTC" })} ${time}`;
}

/** Draws the time the core knows: a real time ahead, an overdue one, or how long it has waited. */
function TimeView({ thing }: { readonly thing: Thing }): JSX.Element {
  const own = thing.face.slaMin ?? thing.dueMin;
  if (own !== undefined && !thing.settled) {
    if (own >= 0)
      return (
        <span className="cd-time is-own">
          {own < 48 * 60 ? formatClock(own) : `in ${formatWait(own)}`}
        </span>
      );
    if (thing.turn === "you" && !thing.lapsed)
      return <span className="cd-time is-over">{formatWait(-own)} overdue</span>;
  }
  if (thing.turn !== "you" || thing.settled)
    return <span className="cd-time">{formatWait(thing.waitMin)}</span>;
  return (
    <span className={`cd-time${isPressing(thing) ? " is-long" : ""}`}>
      waiting {formatWait(thing.waitMin)}
    </span>
  );
}

const TONE_COLOR: Record<Tone, string> = {
  neutral: "#95a2b3",
  progress: "#e2b03b",
  review: "#4cb782",
  brand: "oklch(0.56 0.16 var(--cd-hue, 270))",
  good: "#1a7f37",
  bad: "var(--fail)",
  warn: "#e2803b",
};

const BRANCH_PATH =
  "M1.5 3.25a2.25 2.25 0 1 1 3 2.122v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.25 2.25 0 0 1 1.5 3.25Zm5.677-.177L9.573.677A.25.25 0 0 1 10 .854V2.5h1A2.5 2.5 0 0 1 13.5 5v5.628a2.251 2.251 0 1 1-1.5 0V5a1 1 0 0 0-1-1h-1v1.646a.25.25 0 0 1-.427.177L7.177 3.427a.25.25 0 0 1 0-.354ZM3.75 2.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm0 9.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm8.25.75a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0Z";

/** Draws a plugin's status glyph from the core's fixed set of shapes. */
export function GlyphIcon({ glyph }: { readonly glyph: Glyph }): JSX.Element {
  const c = TONE_COLOR[glyph.tone];
  const fill = glyph.fill ?? 0;
  const angle = fill * 2 * Math.PI;
  return (
    <svg
      className="cd-icon"
      width="14"
      height="14"
      viewBox="0 0 14 14"
      aria-label={glyph.label}
      role="img"
    >
      {glyph.shape === "branch" ? <path d={BRANCH_PATH} fill={c} transform="scale(0.875)" /> : null}
      {glyph.shape === "bar" ? <rect x="5" y="1" width="4" height="12" rx="2" fill={c} /> : null}
      {glyph.shape === "dot" ? <circle cx="7" cy="7" r="4" fill={c} /> : null}
      {glyph.shape === "ring" || glyph.shape === "pie" ? (
        <circle cx="7" cy="7" r="6" fill="none" stroke={c} strokeWidth="1.5" />
      ) : null}
      {glyph.shape === "dashed" ? (
        <circle
          cx="7"
          cy="7"
          r="6"
          fill="none"
          stroke={c}
          strokeWidth="1.5"
          strokeDasharray="2 1.6"
        />
      ) : null}
      {glyph.shape === "pie" ? (
        <path
          d={`M7 7 L7 2 A5 5 0 ${fill > 0.5 ? 1 : 0} 1 ${(7 + 5 * Math.sin(angle)).toFixed(2)} ${(7 - 5 * Math.cos(angle)).toFixed(2)} Z`}
          fill={c}
        />
      ) : null}
      {glyph.shape === "full" || glyph.shape === "check" ? (
        <circle cx="7" cy="7" r="6" fill={c} />
      ) : null}
      {glyph.shape === "check" ? (
        <path d="M4.3 7.2 6.2 9 9.8 5.2" stroke="#fff" strokeWidth="1.5" fill="none" />
      ) : null}
    </svg>
  );
}

/** Draws a level of 0 to 4 as bars, the way trackers draw priority: 1 is urgent, 0 is none. */
function LevelIcon({
  value,
  label,
}: {
  readonly value: number;
  readonly label: string;
}): JSX.Element {
  if (value === 1) {
    return (
      <svg
        className="cd-icon"
        width="14"
        height="14"
        viewBox="0 0 14 14"
        aria-label={label}
        role="img"
      >
        <rect x="1" y="1" width="12" height="12" rx="3" fill="#e2803b" />
        <rect x="6.25" y="3.5" width="1.5" height="4.5" fill="#fff" />
        <rect x="6.25" y="9" width="1.5" height="1.5" fill="#fff" />
      </svg>
    );
  }
  const filled = value === 2 ? 3 : value === 3 ? 2 : value === 4 ? 1 : 0;
  return (
    <svg
      className="cd-icon cd-level"
      width="14"
      height="14"
      viewBox="0 0 14 14"
      aria-label={label}
      role="img"
    >
      {value === 0
        ? [3, 7, 11].map((cx) => (
            <circle key={cx} cx={cx} cy="7" r="1" fill="currentColor" opacity="0.5" />
          ))
        : [0, 1, 2].map((i) => (
            <rect
              key={i}
              x={2 + i * 4}
              y={9 - i * 3}
              width="2.5"
              height={3 + i * 3}
              rx="0.6"
              fill="currentColor"
              opacity={i < filled ? 1 : 0.25}
            />
          ))}
    </svg>
  );
}

/** Draws a 14-day trend as a small area line. */
export function Sparkline({
  values,
  width = 64,
  height = 18,
}: {
  readonly values: readonly number[];
  readonly width?: number;
  readonly height?: number;
}): JSX.Element {
  const max = Math.max(1, ...values);
  const points = values.map(
    (n, i) =>
      `${((i / (values.length - 1)) * width).toFixed(1)},${(height - (n / max) * (height - 2) - 1).toFixed(1)}`,
  );
  return (
    <svg
      className="cd-spark"
      width={width}
      height={height}
      viewBox={`0 0 ${String(width)} ${String(height)}`}
      aria-label="Trend, last 14 days"
      role="img"
    >
      <path
        d={`M0,${String(height)} L${points.join(" L")} L${String(width)},${String(height)} Z`}
        className="cd-spark-area"
      />
      <path d={`M${points.join(" L")}`} className="cd-spark-line" />
    </svg>
  );
}

const HUES = [
  "--hue-sky",
  "--hue-teal",
  "--hue-grape",
  "--hue-peach",
  "--hue-mint",
  "--hue-orchid",
  "--hue-iris",
  "--hue-lime",
];

/** Draws a person as a circle with their initials, in a hue picked from their name. "You" takes the user's marigold. */
export function Avatar({
  name,
  size = 18,
  square = false,
}: {
  readonly name: string;
  readonly size?: number;
  readonly square?: boolean;
}): JSX.Element {
  const hue = HUES[[...name].reduce((h, c) => h + c.charCodeAt(0), 0) % HUES.length]!;
  const initials =
    name === "You"
      ? "Y"
      : name
          .replace(/[^A-Za-z ]/g, "")
          .split(" ")
          .map((w) => w[0])
          .join("")
          .slice(0, 2)
          .toUpperCase();
  return (
    <span
      className={`cd-avatar${square ? " is-square" : ""}`}
      style={{
        width: size,
        height: size,
        fontSize: Math.round(size * 0.42),
        background: name === "You" ? "var(--you)" : `oklch(0.62 0.13 var(${hue}))`,
      }}
      aria-label={name}
    >
      {initials || "?"}
    </span>
  );
}

function PartView({ part }: { readonly part: Part }): JSX.Element | null {
  switch (part.type) {
    case "text":
      return part.text ? (
        <span className={`cd-text${part.tone ? ` is-${part.tone}` : ""}`}>{part.text}</span>
      ) : null;
    case "id":
      return part.text ? <span className="cd-id">{part.text}</span> : null;
    case "person":
      return <Avatar name={part.name} size={18} square={part.square ?? false} />;
    case "people":
      return part.names.length === 0 ? null : (
        <span className="cd-faces">
          {part.names.slice(0, 4).map((n) => (
            <Avatar key={n} name={n} size={16} square={part.square ?? false} />
          ))}
        </span>
      );
    case "count":
      return (
        <span className={`cd-count${part.tone ? ` is-${part.tone}` : ""}`}>
          {formatCount(part.n)} {part.noun}
        </span>
      );
    case "diff":
      return (
        <span className="cd-diff">
          <ins>+{formatCount(part.add)}</ins> <del>−{formatCount(part.del)}</del>
        </span>
      );
    case "level":
      return <LevelIcon value={part.value} label={part.label} />;
    case "chip":
      return part.text ? <span className="cd-chip">{part.text}</span> : null;
    case "code":
      return <code className="cd-code">{part.text}</code>;
    case "trend":
      return <Sparkline values={part.values} />;
  }
}
