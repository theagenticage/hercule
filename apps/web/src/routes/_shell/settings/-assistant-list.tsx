import type { JSX, Ref } from "react";
import type { Assistant } from "@hercule/contract";
import { Group, LaneLabel, ListRow } from "@hercule/ui";

/**
 * Renders the list of assistants under an "Assistants" label, with the
 * selected one marked.
 *
 * - `onSelect` runs when the user picks an assistant other than the selected one.
 * - `selectedRowRef` receives the selected row, so the screen can move focus to it.
 * - `disabled` disables every row.
 */
export function AssistantList({
  assistants,
  selectedId,
  selectedRowRef,
  disabled,
  onSelect,
}: {
  readonly assistants: readonly Assistant[];
  readonly selectedId: string;
  readonly selectedRowRef: Ref<HTMLButtonElement>;
  readonly disabled: boolean;
  readonly onSelect: (assistantId: string) => void;
}): JSX.Element {
  return (
    <div>
      <LaneLabel>Assistants</LaneLabel>
      {/* The settings screens are a column of 520px cards, so the list uses
          the same width. */}
      <div className="max-w-[520px]">
        <Group>
          <ul className="flex flex-col">
            {assistants.map((assistant) => (
              <li key={assistant.id}>
                <ListRow
                  ref={assistant.id === selectedId ? selectedRowRef : undefined}
                  selected={assistant.id === selectedId}
                  disabled={disabled}
                  onClick={() => {
                    if (assistant.id !== selectedId) onSelect(assistant.id);
                  }}
                >
                  <span className="min-w-0 truncate font-emph text-ink">{assistant.name}</span>
                </ListRow>
              </li>
            ))}
          </ul>
        </Group>
      </div>
    </div>
  );
}
