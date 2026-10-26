import { useId, type JSX } from "react";
import type { TextSizeStep } from "../../../../ipc/appearance";
import { SettingRow } from "../setting-row";
import "./appearance.css";

/** The four steps, smallest first, each with the word that names it for a screen reader. */
const TEXT_SIZE_STEP_NAMES: ReadonlyArray<{ readonly step: TextSizeStep; readonly name: string }> =
  [
    { step: 1, name: "smallest" },
    { step: 2, name: "default" },
    { step: 3, name: "larger" },
    { step: 4, name: "largest" },
  ];

/**
 * Renders the Text size row of Settings > Appearance: four "Aa" steps, each
 * drawn in the size its step gives body text, from the smallest to the
 * largest. The step in use is pressed.
 *
 * - The steps are native radio buttons in one group, so the arrow keys move
 *   between them. They are named "Text size: smallest", "Text size: default",
 *   "Text size: larger" and "Text size: largest".
 * - Choosing a step calls `onChange` with it. Choosing the step in use does
 *   not call it.
 * - `error` is why the row's last save failed, shown under the row, or `null`.
 */
export function TextSizeRow({
  textSize,
  onChange,
  error,
}: {
  readonly textSize: TextSizeStep;
  readonly onChange: (step: TextSizeStep) => void;
  readonly error: string | null;
}): JSX.Element {
  const groupName = useId();
  return (
    <SettingRow
      label="Text size"
      error={error}
      hint="Transcripts follow; titles stay modest."
      control={(labels) => (
        <div className="seg sizes" role="radiogroup" {...labels}>
          {TEXT_SIZE_STEP_NAMES.map(({ step, name }) => (
            <label key={step}>
              <input
                type="radio"
                name={groupName}
                aria-label={`Text size: ${name}`}
                checked={textSize === step}
                onChange={() => {
                  onChange(step);
                }}
              />
              <span aria-hidden="true">Aa</span>
            </label>
          ))}
        </div>
      )}
    />
  );
}
