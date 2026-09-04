import type { JSX } from "react";
import { cn } from "./cn";

/** The three greys importance is drawn in. Nothing here is a semantic hue. */
const tones = {
  faint: "text-faint",
  muted: "text-muted",
  ink: "text-ink",
};

export type GlyphTone = keyof typeof tones;

/**
 * Importance as three rising bars: how many are painted, and in which grey.
 *
 * Colour never says how much something matters - a hue is reserved for what is
 * happening to it - so the two axes here are shape and ink, and nothing else.
 */
export function PriorityGlyph({
  filled,
  tone = "muted",
  label,
  className,
}: {
  readonly filled: 1 | 2 | 3;
  readonly tone?: GlyphTone;
  readonly label: string;
  readonly className?: string;
}): JSX.Element {
  return (
    <span
      role="img"
      aria-label={label}
      className={cn("inline-flex shrink-0 items-center", tones[tone], className)}
    >
      <svg viewBox="0 0 12 12" width={12} height={12} aria-hidden="true">
        {[3, 5, 7].map((height, index) => (
          <rect
            key={height}
            data-bar
            data-filled={index < filled ? "true" : "false"}
            x={1.5 + index * 3.5}
            y={9.5 - height}
            width={2}
            height={height}
            rx={1}
            fill="currentColor"
            opacity={index < filled ? 1 : 0.25}
          />
        ))}
      </svg>
    </span>
  );
}
