import { useId, type JSX } from "react";
import { useTextDraft } from "./use-text-draft";

/**
 * Renders one setting whose value is a long text: its label and hint above a
 * textarea the width of the section, and under them `error` when the last
 * save failed (spec 17 §Settings, The frame, Saving). The textarea grows
 * with its text, so it never scrolls.
 *
 * The text saves through `onCommit` as `useTextDraft` describes: when the
 * textarea loses focus or on Cmd+Enter, and only when it changed.
 */
export function SettingTextRow({
  label,
  hint,
  value,
  error,
  onCommit,
}: {
  readonly label: string;
  readonly hint: string;
  readonly value: string;
  readonly error: string | null;
  readonly onCommit: (text: string) => void;
}): JSX.Element {
  const id = useId();
  const draft = useTextDraft(value, onCommit);
  return (
    <>
      <div className="set-row set-row--text">
        <div className="set-label">
          <b id={`${id}-label`}>{label}</b>
          <span id={`${id}-hint`}>{hint}</span>
        </div>
        <textarea
          className="field"
          aria-labelledby={`${id}-label`}
          aria-describedby={`${id}-hint`}
          {...draft}
        />
      </div>
      {error !== null && (
        <p className="set-err" role="alert">
          {error}
        </p>
      )}
    </>
  );
}
