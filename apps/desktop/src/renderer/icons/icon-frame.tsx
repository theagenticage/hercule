import type { JSX, ReactNode } from "react";
import "./icon.css";

/** Props every icon takes: its size in CSS pixels, 16 by default. */
export interface IconProps {
  readonly size?: number;
}

/**
 * Renders the frame every icon shares: a 16-unit grid, 1.5 stroke in the
 * current text colour, round caps. Hidden from assistive technology.
 *
 * The attributes are the Bureau book's, in the book's order, so the markup
 * matches what the book's crew.js draws attribute for attribute.
 */
export function IconFrame({
  size = 16,
  children,
}: IconProps & { readonly children: ReactNode }): JSX.Element {
  return (
    <svg
      className="ic"
      viewBox="0 0 16 16"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}
