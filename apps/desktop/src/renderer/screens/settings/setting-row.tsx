import { useId, type JSX, type ReactNode } from "react";

/** The attributes that tie a row's control to the row's label and hint. */
export interface SettingControlLabels {
  readonly "aria-labelledby": string;
  readonly "aria-describedby": string;
}

/**
 * Renders one setting: its label and its hint on the left, its control on
 * the right, and under them `error` when the last save failed (spec 17
 * §Settings, The frame, Saving). The markup is the book's `set-row`.
 *
 * `control` receives the attributes that name the control after the label
 * and describe it with the hint, so a screen reader reads both. While the
 * body is narrower than 520px, the control stacks under the label.
 */
export function SettingRow({
  label,
  hint,
  error = null,
  control,
}: {
  readonly label: string;
  readonly hint: string;
  readonly error?: string | null;
  readonly control: (labels: SettingControlLabels) => ReactNode;
}): JSX.Element {
  const id = useId();
  const labelId = `${id}-label`;
  const hintId = `${id}-hint`;
  return (
    <>
      <div className="set-row">
        <div className="set-label">
          <b id={labelId}>{label}</b>
          <span id={hintId}>{hint}</span>
        </div>
        {control({ "aria-labelledby": labelId, "aria-describedby": hintId })}
      </div>
      {error !== null && (
        <p className="set-err" role="alert">
          {error}
        </p>
      )}
    </>
  );
}
