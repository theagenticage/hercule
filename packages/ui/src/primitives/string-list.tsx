import type { JSX } from "react";
import { Button } from "./button";
import { Input } from "./input";

/**
 * An editable list of short strings, with one field per entry. A single
 * comma-separated field could not hold a value that contains a comma.
 *
 * An empty list shows no fields, because a blank field would look like an
 * entry already started. The group carries the accessible name, because there
 * is no single field for a label to point at.
 */
export function StringList({
  label,
  values,
  required = false,
  onChange,
  addLabel = "Add",
}: {
  /** The list's name, used for the group and in each entry's accessible name. */
  readonly label: string;
  /** Set on the group, because the list as a whole is required, not any one entry. */
  readonly required?: boolean;
  readonly values: ReadonlyArray<string>;
  readonly onChange: (values: ReadonlyArray<string>) => void;
  readonly addLabel?: string;
}): JSX.Element {
  const replaceEntry = (index: number, value: string): void => {
    onChange(values.map((each, at) => (at === index ? value : each)));
  };
  const buildEntryName = (index: number): string => `${label} entry ${String(index + 1)}`;

  return (
    <div
      role="group"
      aria-label={label}
      aria-required={required ? true : undefined}
      className="flex flex-col items-start gap-1.5"
    >
      {values.map((value, index) => (
        // Entries have no identity of their own, so the position is the key;
        // the list is short and only ever edited in place.
        <div key={index} className="flex w-full items-center gap-1.5">
          <Input
            aria-label={buildEntryName(index)}
            value={value}
            onChange={(event) => {
              replaceEntry(index, event.target.value);
            }}
          />
          <Button
            aria-label={`Remove ${buildEntryName(index)}`}
            onClick={() => {
              onChange(values.filter((_, at) => at !== index));
            }}
          >
            Remove
          </Button>
        </div>
      ))}
      {/* Shifted left by the button's padding, so its text lines up with the
          rest of the form. It is drawn in ink with a leading `+`, like the
          app's other add buttons, because a muted word under a form looks like
          another field's label. */}
      <Button
        className="-ml-2 text-ink"
        onClick={() => {
          onChange([...values, ""]);
        }}
      >
        <span aria-hidden="true" className="font-mono text-row text-faint">
          +
        </span>
        {addLabel}
      </Button>
    </div>
  );
}
