import { useId, type JSX } from "react";
import "./intake-settings.css";

/**
 * Renders one kind of Settings > Signals: its label and hint, a switch, and
 * under the label, where its value comes from. The markup is the book's
 * `set-row`. `error` is why the row's last save failed, shown under the row,
 * or `null`.
 *
 * - The switch is named after the label and described by the hint and, when
 *   there is one, the source line. Pressing it calls `onToggle` with the value
 *   it asks for.
 * - `source` is the line under the hint that names the level the value comes
 *   from, or `null` for a value the plugin sets by default.
 * - A row with `canReset` has a Reset button beside the switch, which calls
 *   `onReset`. While `resetting`, the button is dimmed and does nothing, so
 *   the reset is not sent twice.
 */
export function IntakeKindRow({
  label,
  hint,
  hintIsCode = false,
  on,
  source,
  canReset,
  resetting,
  error,
  onToggle,
  onReset,
}: {
  readonly label: string;
  readonly hint: string;
  /** Draws the hint in the code font, such as an event kind's id. */
  readonly hintIsCode?: boolean;
  readonly on: boolean;
  readonly source: string | null;
  readonly canReset: boolean;
  readonly resetting: boolean;
  readonly error: string | null;
  readonly onToggle: (on: boolean) => void;
  readonly onReset: () => void;
}): JSX.Element {
  const id = useId();
  const labelId = `${id}-label`;
  const hintId = `${id}-hint`;
  const sourceId = `${id}-source`;

  return (
    <>
      <div className="set-row intake-row">
        <div className="set-label">
          <b id={labelId}>{label}</b>
          <span id={hintId} className={hintIsCode ? "mono" : undefined}>
            {hint}
          </span>
          {source !== null && (
            <span id={sourceId} className="intake-source">
              {source}
            </span>
          )}
        </div>
        <div className="intake-controls">
          {canReset && (
            <button
              type="button"
              className="btn btn--quiet btn--sm"
              aria-label={`Reset ${label}`}
              aria-disabled={resetting || undefined}
              data-unready={resetting ? "" : undefined}
              onClick={resetting ? undefined : onReset}
            >
              Reset
            </button>
          )}
          <button
            type="button"
            className="toggle"
            role="switch"
            aria-checked={on}
            aria-labelledby={labelId}
            aria-describedby={source === null ? hintId : `${hintId} ${sourceId}`}
            onClick={() => {
              onToggle(!on);
            }}
          />
        </div>
      </div>
      {error !== null && (
        <p className="set-err" role="alert">
          {error}
        </p>
      )}
    </>
  );
}
