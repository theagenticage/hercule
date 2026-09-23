import type { JSX } from "react";
import { cn } from "./cn";

/** The three greys a priority glyph can be drawn in. None of them is a semantic hue. */
const tones = {
  faint: "text-faint",
  muted: "text-muted",
  ink: "text-ink",
};

export type GlyphTone = keyof typeof tones;

/**
 * Shows importance as three rising bars: how many are filled, and in which grey.
 *
 * Colour never shows how much something matters, because hues are reserved for
 * what is happening to a thing. So importance uses only the number of bars and
 * the grey.
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
