import type { JSX } from "react";
import type { IntakeSegment } from "@hercule/client-core";
import "./intake-settings.css";

/**
 * Renders the segmented control above a plugin's lists: one button for
 * all the plugin's Connections, and one for each Connection. The pressed
 * button is the level the lists show and edit. `name` names the group for
 * assistive technology, and `onSelect` receives the `connectionId` of the
 * button pressed, which is `undefined` for all Connections.
 *
 * A label too long for the window is cut with an ellipsis, and the button's
 * `title` holds it whole.
 */
export function IntakeSegments({
  name,
  segments,
  selectedConnectionId,
  onSelect,
}: {
  readonly name: string;
  readonly segments: ReadonlyArray<IntakeSegment>;
  readonly selectedConnectionId: string | undefined;
  readonly onSelect: (connectionId: string | undefined) => void;
}): JSX.Element {
  return (
    <div className="seg intake-segments" role="group" aria-label={name}>
      {segments.map(({ connectionId, label }) => (
        <button
          key={connectionId ?? ""}
          type="button"
          title={label}
          aria-pressed={connectionId === selectedConnectionId}
          onClick={() => {
            onSelect(connectionId);
          }}
        >
          <span>{label}</span>
        </button>
      ))}
    </div>
  );
}
