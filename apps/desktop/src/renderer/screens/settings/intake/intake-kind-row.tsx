import { useEffect, useId, useRef, useState, type JSX } from "react";
import "./intake-settings.css";

/**
 * How long a row the link points at keeps its tint before the tint fades, in
 * milliseconds. The tint needs to be seen after the scroll that brings the row
 * into view, and the fade itself takes `--dur-3`.
 */
const POINTED_HOLD_MS = 1000;

/**
 * Renders one kind of Settings > Intake: its label and hint, a switch, and
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
 * - A `pointed` row is the one a link asks for. When it first appears it
 *   scrolls into view and is drawn with the selected tint, which then fades
 *   once. The tint is a transition of the background, so it ends on its own.
 */
export function IntakeKindRow({
  label,
  hint,
  hintIsCode = false,
  on,
  source,
  canReset,
  resetting,
  pointed,
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
  readonly pointed: boolean;
  readonly error: string | null;
  readonly onToggle: (on: boolean) => void;
  readonly onReset: () => void;
}): JSX.Element {
  const id = useId();
  const labelId = `${id}-label`;
  const hintId = `${id}-hint`;
  const sourceId = `${id}-source`;
  const rowRef = useRef<HTMLDivElement>(null);
  const [tinted, setTinted] = useState(pointed);

  useEffect(() => {
    if (!pointed) return;
    rowRef.current?.scrollIntoView({ block: "center" });
    const timer = setTimeout(() => {
      setTinted(false);
    }, POINTED_HOLD_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [pointed]);

  return (
    <>
      <div ref={rowRef} className={tinted ? "set-row intake-row is-pointed" : "set-row intake-row"}>
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
