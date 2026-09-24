import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

/**
 * The names of the type scale's font sizes (`text-row`, `text-body`, ...).
 *
 * tailwind-merge must be told that these are sizes. Otherwise it treats
 * `text-<word>` as a colour, puts a component's size and a caller's colour in
 * the same group, and drops the size. Every name in the lists below is
 * declared in `styles.css`; keep them in step.
 */
const TEXT_SIZES = ["label", "fine", "meta", "row", "body", "lead", "title"] as const;

/**
 * The names of the font weights (`font-emph`, `font-urgent`). Without them,
 * tailwind-merge reads `font-<word>` as a font family, so `font-mono` beside
 * `font-emph` is dropped and the text falls back to the UI face.
 */
const FONT_WEIGHTS = ["emph", "urgent"] as const;

/**
 * The names of the radii (`rounded-card`, `rounded-control`). Without them,
 * tailwind-merge keeps both when a caller overrides a component's radius.
 */
const RADII = ["card", "control"] as const;

/** The names of the shadows (`shadow-card`, `shadow-lift`), so they are not read as colours. */
const SHADOWS = ["card", "lift"] as const;

const merge = extendTailwindMerge({
  extend: {
    classGroups: {
      "font-size": [{ text: [...TEXT_SIZES] }],
      "font-weight": [{ font: [...FONT_WEIGHTS] }],
      rounded: [{ rounded: [...RADII] }],
      shadow: [{ shadow: [...SHADOWS] }],
    },
  },
});

/** Joins class names so a caller's `className` wins over a component's own. */
export function cn(...classes: ClassValue[]): string {
  return merge(clsx(classes));
}
