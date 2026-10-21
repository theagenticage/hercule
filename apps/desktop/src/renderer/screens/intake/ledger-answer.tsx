/**
 * One answer of a pane, drawn as a row of the answers ledger: the button, what
 * pressing it does, and the key that presses it. The signal pane and the
 * Tracking pane both draw their answers with it, so the two panes look and
 * read the same (spec 17 §The pane).
 */
import type { JSX, ReactNode } from "react";

/**
 * Renders the row of the answer `answerId`: a button with `label` in a
 * `buttonClass` button face, the `describe` line beside it, and `shortcut` as
 * the key that presses it, when it has one. `mark` is drawn before the label,
 * such as the face of the agent the answer hands the work to.
 *
 * `error` shows under the button when the answer failed. While `locked`, the
 * answer keeps its place and its focus, and does nothing. `idPrefix` makes the
 * ids of the describe line and the error unique on the page, and `answerId`
 * is also the value of the button's `data-answer`, which the panes' keys
 * look the button up by.
 */
export function LedgerAnswer({
  answerId,
  label,
  buttonClass,
  mark,
  describe,
  shortcut,
  error,
  locked,
  idPrefix,
  onPress,
}: {
  readonly answerId: string;
  readonly label: string;
  readonly buttonClass: string;
  readonly mark?: ReactNode;
  readonly describe: ReactNode;
  readonly shortcut: string | null;
  readonly error: string | null;
  readonly locked: boolean;
  readonly idPrefix: string;
  readonly onPress: () => void;
}): JSX.Element {
  const describeId = `${idPrefix}-${answerId}-describe`;
  const errorId = `${idPrefix}-${answerId}-error`;
  return (
    <>
      <button
        type="button"
        className="ans"
        data-answer={answerId}
        aria-label={label}
        aria-describedby={error === null ? describeId : `${describeId} ${errorId}`}
        aria-disabled={locked || undefined}
        onClick={() => {
          if (!locked) onPress();
        }}
      >
        <span className={buttonClass}>
          {mark}
          <span className="ans-label">{label}</span>
        </span>
        <span className="ans-desc" id={describeId}>
          {describe}
        </span>
        {shortcut !== null && <kbd aria-hidden="true">{shortcut}</kbd>}
      </button>
      {error !== null && (
        <p className="ad-err" id={errorId} role="alert">
          {error}
        </p>
      )}
    </>
  );
}
