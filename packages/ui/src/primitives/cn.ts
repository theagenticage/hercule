import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

/**
 * The names of the type scale's font sizes (`text-row`, `text-body`, ...).
 *
 * tailwind-merge must be told that these are sizes. Otherwise it treats
 * `text-<word>` as a colour, puts a component's size and a caller's colour in
 * the same group, and drops the size. Every name here is a font size declared
 * in `styles.css`; keep the two lists in step.
 */
const TEXT_SIZES = ["label", "fine", "meta", "row", "body", "lead", "title"] as const;

const merge = extendTailwindMerge({
  extend: { classGroups: { "font-size": [{ text: [...TEXT_SIZES] }] } },
});

/** Joins class names so a caller's `className` wins over a component's own. */
export function cn(...classes: ClassValue[]): string {
  return merge(clsx(classes));
}
