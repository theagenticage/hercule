import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

/**
 * The type scale, named rather than sized (`text-row`, `text-body`).
 *
 * The merge has to be told about them: to it, `text-<word>` is a colour, so a
 * component setting its own size and a caller setting a colour would land in
 * one group and the size would be dropped. Every name here is a font size in
 * `styles.css`, and this list is the other half of that declaration.
 */
const TEXT_SIZES = ["label", "fine", "meta", "row", "body", "lead", "title"] as const;

const merge = extendTailwindMerge({
  extend: { classGroups: { "font-size": [{ text: [...TEXT_SIZES] }] } },
});

/** Joins class names so a caller's `className` wins over a component's own. */
export function cn(...classes: ClassValue[]): string {
  return merge(clsx(classes));
}
