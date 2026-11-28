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
 * Mac, a server for any other machine), its name, whom the account is signed
 * in as there when it is ready, else the `problem` that stops it, and the one
 * `action` the machine offers, if any, such as Sign in or Update. `error` is
 * why the last action failed, shown under the row.
 */
export function MachineRow({
  runnerName,
  isThisMac,
  ready,
  identity,
  problem,
  action,
  error,
}: {
  readonly runnerName: string;
  readonly isThisMac: boolean;
  readonly ready: boolean;
  /** Who the account is signed in as there, or `null` when it is not ready or nobody is named. */
  readonly identity: string | null;
  /** What stops the account there, such as "Codex 0.169.0 is too old", or `null` when it is ready. */
  readonly problem: string | null;
  readonly action: MachineAction | null;
  readonly error: string | null;
}): JSX.Element {
  const status = ready ? (identity ?? "Signed in") : (problem ?? "Not ready");
  return (
    <div className="pa-machine-wrap">
      <div className="pa-machine">
        {isThisMac ? <LaptopIcon size={14} /> : <ServerIcon size={14} />}
        <span className="pa-machine-name">
          <span>{runnerName}</span>
          {isThisMac && <small>this Mac</small>}
        </span>
        <span
          className={ready ? "pa-machine-status" : "pa-machine-status is-you"}
          title={ready && identity !== null ? `Signed in as ${identity}` : undefined}
        >
          <i className={ready ? "pa-pip" : "pa-pip is-you"} />
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
