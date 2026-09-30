import { useId, type JSX } from "react";
import { buildOptionsMenu, parseOptionChoice } from "@hercule/client-core";
import type { ModelOption } from "@hercule/contract";

/**
 * Renders the content of the model options menu: a header with the model's
 * name, then each option the model declares, as its label above one button
 * per choice. The pressed button is the value the next message will use.
 *
 * `descriptors` are the options the model declares and `selected` the
 * values in use, picks included. `onPick` receives the option's id and the
 * value picked: a boolean for an off/on option, since the provider expects
 * one, and the choice's value otherwise. A pick leaves the menu open, so
 * several options can be set in one visit.
 */
export function OptionsMenu({
  descriptors,
  selected,
  modelName,
  onPick,
}: {
  readonly descriptors: readonly ModelOption[];
  readonly selected: Readonly<Record<string, string | boolean>>;
  readonly modelName: string | null;
  readonly onPick: (id: string, value: string | boolean) => void;
}): JSX.Element {
  const labelId = useId();
  return (
    <>
      <div className="pop-h">
        <b>Model options</b>
        {modelName === null ? null : <span>{modelName}</span>}
      </div>
      <div className="pop-sec">
        {buildOptionsMenu(descriptors, selected).map((row) => (
          <div key={row.id} className="menu-option">
            <span className="q-h" id={`${labelId}-${row.id}`}>
              {row.label}
            </span>
            <div className="seg" role="group" aria-labelledby={`${labelId}-${row.id}`}>
              {row.choices.map((choice) => (
                <button
                  key={choice.value}
                  type="button"
                  aria-pressed={choice.value === row.value}
                  onClick={() => {
                    onPick(row.id, parseOptionChoice(row, choice.value));
                  }}
                >
                  {choice.label}
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
    </>
  );
}
