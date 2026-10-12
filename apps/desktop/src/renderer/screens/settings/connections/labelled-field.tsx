import type { JSX, ReactNode } from "react";

/**
 * Renders a labelled field in the book's form style (`.fl`): `label` above
 * `children`, then `hint` under them, then `error` when there is one. Unlike
 * the first run's `FormField`, it draws no field box of its own, so
 * `children` can be any control: a text field, a select, a list of fields or
 * a list of checkboxes. The hint stays visible beside an error, because a
 * hint here explains the setting rather than the format of the value.
 *
 * - With `inputId`, the label is a `<label>` for that control, which takes
 *   its accessible name from it.
 * - Without it, the label is plain text with the id `labelId`, and a control
 *   group among `children` names itself with `aria-labelledby={labelId}`.
 *
 * A control describes itself with the hint through `aria-describedby`, by the
 * id `<labelId>-hint`, which `describeHintId` returns.
 */
export function LabelledField({
  labelId,
  inputId,
  label,
  hint,
  error,
  children,
}: {
  readonly labelId: string;
  readonly inputId?: string | undefined;
  readonly label: string;
  readonly hint?: string | undefined;
  readonly error?: string | undefined;
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <div className="fl">
      <span className="fl-label" id={labelId}>
        {inputId === undefined ? label : <label htmlFor={inputId}>{label}</label>}
      </span>
      {children}
      {hint === undefined ? null : (
        <span className="fl-hint" id={describeHintId(labelId)}>
          {hint}
        </span>
      )}
      {error === undefined ? null : (
        <span className="fl-err" role="alert">
          {error}
        </span>
      )}
    </div>
  );
}

/** Returns the id of the hint of the `LabelledField` whose label has the id `labelId`. */
export const describeHintId = (labelId: string): string => `${labelId}-hint`;
