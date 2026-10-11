import type { JSX } from "react";
import "./intake-settings.css";

/** One button of the control: its text, and the key that tells it from the others. */
export interface IntakeSegmentChoice {
  readonly key: string;
  readonly label: string;
}

/**
 * Renders the segmented control above a plugin's lists: one button for
 * all the plugin's Connections, and one for each Connection. The pressed
 * button is the level the lists show and edit. `name` names the group for
 * assistive technology, and `onSelect` receives the key of the button pressed.
 */
export function IntakeSegments({
  name,
  choices,
  selectedKey,
  onSelect,
}: {
  readonly name: string;
  readonly choices: ReadonlyArray<IntakeSegmentChoice>;
  readonly selectedKey: string;
  readonly onSelect: (key: string) => void;
}): JSX.Element {
  return (
    <div className="seg intake-segments" role="group" aria-label={name}>
      {choices.map(({ key, label }) => (
        <button
          key={key}
          type="button"
          aria-pressed={key === selectedKey}
          onClick={() => {
            onSelect(key);
          }}
        >
          {label}
        </button>
      ))}
    </div>
  );
}
