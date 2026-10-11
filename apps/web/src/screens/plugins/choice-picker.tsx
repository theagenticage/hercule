import { useState, type JSX } from "react";
import { Checkbox, Input, Select } from "@hercule/ui";
import {
  filterChoiceOptions,
  showsChoiceFilter,
  type ChoiceOption,
  type ConfigValue,
} from "@hercule/client-core";

/**
 * The picker for a config field whose choices load from the account: a
 * dropdown for a single value, a list of checkboxes for several. Both show
 * the choices' labels and store their values. With more choices than a short
 * list holds, a filter box sits above the picker.
 *
 * Presentational: the parent loads the choices and builds the rows, including
 * the "Not found" row for a stored value the account no longer has.
 */
export function ChoicePicker({
  inputId,
  label,
  options,
  value,
  multiple,
  required,
  onChange,
}: {
  readonly inputId: string;
  /** The field's name, for the accessible names of the filter box and the list. */
  readonly label: string;
  readonly options: ReadonlyArray<ChoiceOption>;
  readonly value: ConfigValue;
  /** Whether the field holds a list of values rather than one. */
  readonly multiple: boolean;
  readonly required: boolean;
  readonly onChange: (value: ConfigValue) => void;
}): JSX.Element {
  const [typed, setTyped] = useState("");
  const shown = filterChoiceOptions(options, typed, value);

  return (
    <div className="flex flex-col gap-1.5">
      {showsChoiceFilter(options) ? (
        <Input
          aria-label={`Filter ${label}`}
          placeholder="Filter"
          value={typed}
          onChange={(event) => {
            setTyped(event.target.value);
          }}
        />
      ) : null}
      {multiple ? (
        <ChoiceCheckboxes
          label={label}
          shown={shown}
          filtered={typed.trim() !== ""}
          selected={Array.isArray(value) ? value : []}
          onChange={onChange}
        />
      ) : (
        <Select
          id={inputId}
          aria-required={required ? true : undefined}
          value={typeof value === "string" ? value : ""}
          onChange={(event) => {
            onChange(event.target.value);
          }}
        >
          {/* An optional setting needs an empty choice, so the user can unset it. */}
          {required ? null : <option value="">Not set</option>}
          {shown.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </Select>
      )}
    </div>
  );
}

/**
 * The several-value picker: one checkbox per row, in a box that scrolls once
 * the list is long (an account can have up to 1,000 choices).
 */
function ChoiceCheckboxes({
  label,
  shown,
  filtered,
  selected,
  onChange,
}: {
  readonly label: string;
  readonly shown: ReadonlyArray<ChoiceOption>;
  /** Whether the filter box holds text, which decides why an empty list is empty. */
  readonly filtered: boolean;
  readonly selected: ReadonlyArray<string>;
  readonly onChange: (value: ReadonlyArray<string>) => void;
}): JSX.Element {
  return (
    <div
      role="group"
      aria-label={label}
      className="flex max-h-[220px] flex-col gap-2 overflow-y-auto rounded-control border border-line bg-raised px-2.5 py-2"
    >
      {shown.length === 0 ? (
        <p className="text-fine text-faint">{filtered ? "No match." : "The account has none."}</p>
      ) : null}
      {shown.map((option) => (
        <Checkbox
          key={option.value}
          label={option.label}
          checked={selected.includes(option.value)}
          onChange={(event) => {
            onChange(
              event.target.checked
                ? [...selected, option.value]
                : selected.filter((each) => each !== option.value),
            );
          }}
        />
      ))}
    </div>
  );
}
