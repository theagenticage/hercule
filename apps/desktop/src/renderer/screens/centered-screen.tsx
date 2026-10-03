import type { JSX, ReactNode } from "react";
import { LogoMark } from "../logos";
import "./centered-screen.css";

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
          <LogoMark size={40} />
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
