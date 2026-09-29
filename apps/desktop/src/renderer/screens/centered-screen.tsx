import type { JSX, ReactNode } from "react";
import "./centered-screen.css";

/** The outline of the logo mark's egg-shaped head, in a 32 by 32 box. */
const LOGO_HEAD =
  "M16 2.4c-6.3 0-10.9 7.6-10.9 14.8 0 7.1 4.8 12.4 10.9 12.4s10.9-5.3 10.9-12.4C26.9 10 22.3 2.4 16 2.4z";
/** The waxed moustache under the logo mark's eyes, in the same box. */
const LOGO_MOUSTACHE =
  "M16 19.2c-1.5-1.2-3.4-1.5-5.1-.7-.9.4-1.7.3-2.3-.4-.4-.5-1.2-.3-1.1.4.3 1.9 2 3 4 2.8 1.8-.2 3.3-.9 4.5-1.8 1.2.9 2.7 1.6 4.5 1.8 2 .2 3.7-.9 4-2.8.1-.7-.7-.9-1.1-.4-.6.7-1.4.8-2.3.4-1.7-.8-3.6-.5-5.1.7z";

/**
 * Renders the logo mark in colour, at the book's lockup size of 40px. It is
 * hidden from assistive technology, because the wordmark beside it already
 * carries the name.
 */
function LogoMark(): JSX.Element {
  return (
    <svg className="logo" viewBox="0 0 32 32" width="40" height="40" aria-hidden="true">
      <path className="logo-head" d={LOGO_HEAD} />
      <g className="logo-face">
        <circle cx="12.4" cy="14.6" r="1.55" />
        <circle cx="19.6" cy="14.6" r="1.55" />
        <path d={LOGO_MOUSTACHE} />
      </g>
    </svg>
  );
}

/**
 * Renders a screen shown before the shell, such as connecting to a controller
 * or signing in: the logo lockup above one centred column that holds
 * `children`.
 *
 * The screen's parts use the classes in `centered-screen.css`:
 * `centered-form` for the form and `centered-error` for its error line. A line
 * about the controller below them is a `CenteredFooter`.
 */
export function CenteredScreen({ children }: { readonly children: ReactNode }): JSX.Element {
  return (
    <div className="centered-screen">
      <div className="centered-column">
        <h1 className="centered-lockup">
          <LogoMark />
          <span className="wordmark">Hercule</span>
        </h1>
        {children}
      </div>
    </div>
  );
}

/**
 * Renders the quiet line at the foot of a centred screen: `text` about the
 * controller, such as "Connected to http://127.0.0.1:4937", and a Change
 * button that calls `onChange`.
 */
export function CenteredFooter({
  text,
  onChange,
}: {
  readonly text: string;
  readonly onChange: () => void;
}): JSX.Element {
  return (
    <div className="centered-footer">
      <span>{text}</span>
      <button type="button" className="btn btn--quiet" onClick={onChange}>
        Change
      </button>
    </div>
  );
}
