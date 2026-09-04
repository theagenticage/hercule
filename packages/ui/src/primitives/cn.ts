import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/** Joins class names so a caller's `className` wins over a component's own. */
export function cn(...classes: ClassValue[]): string {
  return twMerge(clsx(classes));
}
