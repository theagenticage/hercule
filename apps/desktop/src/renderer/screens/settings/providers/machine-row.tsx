import type { JSX } from "react";
import { LaptopIcon } from "../../../icons/laptop";
import { ServerIcon } from "../../../icons/server";
import "./providers.css";

/** The button at the end of a machine's row. */
export interface MachineAction {
  readonly label: string;
  readonly onPress: () => void;
  /** Why the button cannot be pressed now, shown as its tooltip; the button is dimmed. */
  readonly unavailable?: string;
  /** Whether the press is still running: the button cannot be pressed again. */
  readonly pending?: boolean;
}

/**
 * Renders one machine in an account's sheet: its icon (a laptop for this
 * Mac, a server for any other machine), its name, whether the account is
 * signed in there and as whom, and the one `action` the machine offers, if
 * any, such as Sign in. `error` is why the last action failed, shown under
 * the row.
 */
export function MachineRow({
  runnerName,
  isThisMac,
  signedIn,
  identity,
  action,
  error,
}: {
  readonly runnerName: string;
  readonly isThisMac: boolean;
  readonly signedIn: boolean;
  /** Who the account is signed in as there, or `null` when it is not signed in or nobody is named. */
  readonly identity: string | null;
  readonly action: MachineAction | null;
  readonly error: string | null;
}): JSX.Element {
  const status = signedIn ? (identity ?? "Signed in") : "Not signed in";
  return (
    <div className="pa-machine-wrap">
      <div className="pa-machine">
        {isThisMac ? <LaptopIcon size={14} /> : <ServerIcon size={14} />}
        <span className="pa-machine-name">
          <span>{runnerName}</span>
          {isThisMac && <small>this Mac</small>}
        </span>
        <span
          className={signedIn ? "pa-machine-status" : "pa-machine-status is-you"}
          title={signedIn && identity !== null ? `Signed in as ${identity}` : undefined}
        >
          <i className={signedIn ? "pa-pip" : "pa-pip is-you"} />
          <span>{status}</span>
        </span>
        {action !== null && (
          // A disabled button takes no pointer events, so the tooltip that
          // says why sits on a span around it.
          <span className="pa-machine-act" title={action.unavailable}>
            <button
              type="button"
              className="btn btn--sm"
              disabled={action.unavailable !== undefined || action.pending === true}
              onClick={action.onPress}
            >
              {action.label}
            </button>
          </span>
        )}
      </div>
      {error !== null && (
        <p className="pa-machine-err" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
