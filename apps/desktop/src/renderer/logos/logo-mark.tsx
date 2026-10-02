import type { JSX } from "react";
import "./logos.css";

/** The outline of the logo mark's egg-shaped head, in a 32 by 32 box. */
const LOGO_HEAD =
  "M16 2.4c-6.3 0-10.9 7.6-10.9 14.8 0 7.1 4.8 12.4 10.9 12.4s10.9-5.3 10.9-12.4C26.9 10 22.3 2.4 16 2.4z";
/** The waxed moustache under the logo mark's eyes, in the same box. */
const LOGO_MOUSTACHE =
  "M16 19.2c-1.5-1.2-3.4-1.5-5.1-.7-.9.4-1.7.3-2.3-.4-.4-.5-1.2-.3-1.1.4.3 1.9 2 3 4 2.8 1.8-.2 3.3-.9 4.5-1.8 1.2.9 2.7 1.6 4.5 1.8 2 .2 3.7-.9 4-2.8.1-.7-.7-.9-1.1-.4-.6.7-1.4.8-2.3.4-1.7-.8-3.6-.5-5.1.7z";

/**
 * Renders the logo mark in colour, `size` CSS pixels square, as the Bureau
 * book's `logo()` in crew.js draws it. It is hidden from assistive
 * technology, because every place that draws it also writes the name beside
 * it.
 */
export function LogoMark({ size }: { readonly size: number }): JSX.Element {
  return (
    <svg className="logo" viewBox="0 0 32 32" width={size} height={size} aria-hidden="true">
      <path className="logo-head" d={LOGO_HEAD} />
      <g className="logo-face">
        <circle cx="12.4" cy="14.6" r="1.55" />
        <circle cx="19.6" cy="14.6" r="1.55" />
        <path d={LOGO_MOUSTACHE} />
      </g>
    </svg>
  );
}
