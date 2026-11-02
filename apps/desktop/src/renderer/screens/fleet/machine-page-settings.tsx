import { useRef, useState, type JSX } from "react";
import { CloseIcon } from "../../icons/close";
import { PlusIcon } from "../../icons/plus";
import { SettingRow } from "../settings/setting-row";
import { useTextDraft } from "../settings/use-text-draft";
import "./machine-page.css";

/**
 * Renders a Settings row of a machine whose value is a number in a small
 * field, such as the session cap, with `unit` after it when given.
 *
 * The text typed is committed as `useTextDraft` describes: `onCommit`
 * receives it only when it differs from `value`. So a field that merely lost
 * focus saves nothing. `inputMode` is `numeric` for whole numbers and
 * `decimal` for a number with a decimal. `error` is why the last commit was
 * refused or failed, shown under the row.
 */
export function MachineNumberRow({
  label,
  hint,
  value,
  unit,
  inputMode,
  error,
  onCommit,
}: {
  readonly label: string;
  readonly hint: string;
  readonly value: string;
  readonly unit?: string;
  readonly inputMode: "numeric" | "decimal";
  readonly error: string | null;
  readonly onCommit: (text: string) => void;
}): JSX.Element {
  const draft = useTextDraft(value, onCommit);
  return (
    <SettingRow
      label={label}
      hint={hint}
      error={error}
      control={(labels) => (
        <span className="machine-page-number">
          <input
            className="field machine-page-number-field"
            inputMode={inputMode}
            spellCheck={false}
            {...labels}
            {...draft}
          />
          {unit === undefined ? null : <span className="machine-page-unit">{unit}</span>}
        </span>
      )}
    />
  );
}

/**
 * Renders the Labels row of a machine: a chip for each label with a button
 * that removes it, and Add a label, which opens a small field. Enter or
 * leaving the field adds the label typed (`onAdd`, with the text as typed),
 * and Esc closes the field. Removing a chip calls `onRemove`.
 */
export function MachineLabelsRow({
  labels,
  error,
  onAdd,
  onRemove,
}: {
  readonly labels: readonly string[];
  readonly error: string | null;
  readonly onAdd: (text: string) => void;
  readonly onRemove: (label: string) => void;
}): JSX.Element {
  const [isAdding, setAdding] = useState(false);
  return (
    <SettingRow
      label="Labels"
      hint="Work can ask for a machine by its labels."
      error={error}
      control={(ids) => (
        <span className="machine-page-labels" role="group" aria-labelledby={ids["aria-labelledby"]}>
          {labels.map((label) => (
            <span key={label} className="chip machine-page-label">
              {label}
              <button
                type="button"
                className="machine-page-label-remove"
                aria-label={`Remove the label ${label}`}
                onClick={() => onRemove(label)}
              >
                <CloseIcon size={10} />
              </button>
            </span>
          ))}
          {isAdding ? (
            <NewLabelField
              onCommit={(text) => {
                setAdding(false);
                onAdd(text);
              }}
              onClose={() => setAdding(false)}
            />
          ) : (
            <button
              type="button"
              className="icon-btn icon-btn--sm"
              aria-label="Add a label"
              onClick={() => setAdding(true)}
            >
              <PlusIcon size={12} />
            </button>
          )}
        </span>
      )}
    />
  );
}

/**
 * Renders the small field of Add a label. It takes the focus when it opens.
 * Enter or leaving the field hands the text to `onCommit`, and Esc calls
 * `onClose`. The field acts once: removing it from the page can fire a blur
 * that would hand the same text over a second time.
 */
function NewLabelField({
  onCommit,
  onClose,
}: {
  readonly onCommit: (text: string) => void;
  readonly onClose: () => void;
}): JSX.Element {
  const [text, setText] = useState("");
  const isDone = useRef(false);
  const finish = (act: () => void): void => {
    if (isDone.current) return;
    isDone.current = true;
    act();
  };
  return (
    <input
      ref={(input) => input?.focus()}
      className="field machine-page-label-field"
      aria-label="New label"
      spellCheck={false}
      value={text}
      onChange={(event) => setText(event.target.value)}
      onBlur={() => finish(() => onCommit(text))}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          finish(() => onCommit(text));
        } else if (event.key === "Escape") {
          // Esc would otherwise also close a dialog or the page around the field.
          event.stopPropagation();
          finish(onClose);
        }
      }}
    />
  );
}

/**
 * Renders a Settings row of a machine with a switch. Pressing the switch calls
 * `onToggle`; `checked` is the value shown, which is the new value while it
 * saves. `error` is why the last save failed, shown under the row.
 */
export function MachineSwitchRow({
  label,
  hint,
  checked,
  error,
  onToggle,
}: {
  readonly label: string;
  readonly hint: string;
  readonly checked: boolean;
  readonly error: string | null;
  readonly onToggle: () => void;
}): JSX.Element {
  return (
    <SettingRow
      label={label}
      hint={hint}
      error={error}
      control={(ids) => (
        <button
          type="button"
          className="toggle"
          role="switch"
          aria-checked={checked}
          {...ids}
          onClick={onToggle}
        />
      )}
    />
  );
}

/** Renders the Retire row of a machine: Retire…, which calls `onRetire`. */
export function MachineRetireRow({ onRetire }: { readonly onRetire: () => void }): JSX.Element {
  return (
    <SettingRow
      label="Retire this machine…"
      hint="Forgets it. Its threads keep their transcripts, but cannot resume."
      control={() => (
        <button type="button" className="btn btn--danger" onClick={onRetire}>
          Retire…
        </button>
      )}
    />
  );
}
