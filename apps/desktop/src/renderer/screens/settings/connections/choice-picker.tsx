import { useState, type JSX } from "react";
import {
  filterChoiceOptions,
  showsChoiceFilter,
  type ChoiceOption,
  type ConfigValue,
} from "@hercule/client-core";
import { CheckIcon } from "../../../icons/check";
import { SearchIcon } from "../../../icons/search";

/**
 * Renders the picker of a setting whose choices load from an account: a
 * select for one value, a list of checkboxes for several. Both show the
 * choices' labels and store their values. With more choices than a short
 * list holds, a filter field sits above the picker.
 *
 * Presentational: the caller loads the choices and builds `options` with
 * `buildChoiceOptions`, which puts a "Not found" row first for a stored value
 * the account no longer has. The picker sits inside a `LabelledField`:
 *
 * - the select is named by the field's `<label>`, through `inputId`;
 * - the checkbox list is named by the label's id, `labelId`.
 */
export function ChoicePicker({
  inputId,
  labelId,
  hintId,
  label,
  options,
  value,
  multiple,
  required,
  invalid,
  onChange,
}: {
  readonly inputId: string;
  readonly labelId: string;
  /** The id of the field's hint, or `undefined` when the field has none. */
  readonly hintId: string | undefined;
  /** The setting's name, for the filter field's accessible name. */
  readonly label: string;
  readonly options: ReadonlyArray<ChoiceOption>;
  readonly value: ConfigValue;
  /** Whether the setting holds a list of values rather than one. */
  readonly multiple: boolean;
  readonly required: boolean;
  /** Whether the setting has an error, which draws the picker's red edge. */
  readonly invalid: boolean;
  readonly onChange: (value: ConfigValue) => void;
}): JSX.Element {
  const [typed, setTyped] = useState("");
  const shown = filterChoiceOptions(options, typed, value);

  return (
    <>
      {showsChoiceFilter(options) ? (
        <span className="field choice-filter">
          <SearchIcon size={14} />
          <input
            aria-label={`Filter ${label}`}
            placeholder="Filter choices…"
            spellCheck={false}
            autoComplete="off"
            value={typed}
            onChange={(event) => {
              setTyped(event.target.value);
            }}
          />
        </span>
      ) : null}
      {multiple ? (
        <ChoiceCheckboxes
          labelId={labelId}
          hintId={hintId}
          shown={shown}
          invalid={invalid}
          filtered={typed.trim() !== ""}
          selected={Array.isArray(value) ? value : []}
          onChange={onChange}
        />
      ) : (
        <span className={invalid ? "field field--select is-bad" : "field field--select"}>
          <select
            id={inputId}
            aria-describedby={hintId}
            aria-required={required ? true : undefined}
            aria-invalid={invalid ? true : undefined}
            value={typeof value === "string" ? value : ""}
            onChange={(event) => {
              onChange(event.target.value);
            }}
          >
            {/* An optional setting needs an empty choice, so the user can
                unset it. A value that is not set needs it too, or the select
                would appear to hold the first choice. */}
            {required && value !== "" ? null : <option value="">Not set</option>}
            {shown.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </span>
      )}
    </>
  );
}

/**
 * Renders the several-value picker: one checkbox per choice, in a box that
 * scrolls once the list is long, because an account can offer up to 1,000
 * choices.
 */
function ChoiceCheckboxes({
  labelId,
  hintId,
  shown,
  invalid,
  filtered,
  selected,
  onChange,
}: {
  readonly labelId: string;
  readonly hintId: string | undefined;
  readonly shown: ReadonlyArray<ChoiceOption>;
  readonly invalid: boolean;
  /** Whether the filter field holds text, which decides why an empty list is empty. */
  readonly filtered: boolean;
  readonly selected: ReadonlyArray<string>;
  readonly onChange: (value: ReadonlyArray<string>) => void;
}): JSX.Element {
  return (
    <div
      role="group"
      aria-labelledby={labelId}
      aria-describedby={hintId}
      aria-invalid={invalid ? true : undefined}
      className={invalid ? "options choice-list is-bad" : "options choice-list"}
    >
      {shown.length === 0 ? (
        <p className="fine choice-list-empty">
          {filtered ? "No choice matches the filter." : "The account offers no choices."}
        </p>
      ) : null}
      {shown.map((option) => (
        <label key={option.value} className="option">
          <span className="choice-box">
            <input
              type="checkbox"
              checked={selected.includes(option.value)}
              onChange={(event) => {
                onChange(
                  event.target.checked
                    ? [...selected, option.value]
                    : selected.filter((each) => each !== option.value),
                );
              }}
            />
            <CheckIcon size={12} />
          </span>
          <b>{option.label}</b>
        </label>
      ))}
    </div>
  );
}
