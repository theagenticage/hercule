import type { JSX } from "react";
import { Button } from "./button";
import { Input } from "./input";

/**
 * A list of short strings, edited one entry at a time.
 *
 * A single comma-separated box would be less to build and would quietly refuse
 * any value with a comma in it, so each entry gets its own field. An empty list
 * shows no fields at all: the Add button is what says there is a list here, and
 * a blank row would read as an entry the user had already started.
 *
 * The group carries the name, because there is no one field for a label to
 * point at: an empty list has no entry at all, and a full one has several.
 */
export function StringList({
  label,
  values,
  required = false,
  onChange,
  addLabel = "Add",
}: {
  /** What the list is called, for the group and for each entry's own name. */
  readonly label: string;
  /** Whether the list has to hold something. Announced on the group, since it
   * is the list rather than any one entry that is being asked for. */
  readonly required?: boolean;
  readonly values: ReadonlyArray<string>;
  readonly onChange: (values: ReadonlyArray<string>) => void;
  readonly addLabel?: string;
}): JSX.Element {
  const replace = (index: number, value: string): void => {
    onChange(values.map((each, at) => (at === index ? value : each)));
  };
  const entryName = (index: number): string => `${label} entry ${String(index + 1)}`;

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
            aria-label={entryName(index)}
            value={value}
            onChange={(event) => {
              replace(index, event.target.value);
            }}
          />
          <Button
            aria-label={`Remove ${entryName(index)}`}
            onClick={() => {
              onChange(values.filter((_, at) => at !== index));
            }}
          >
            Remove
          </Button>
        </div>
      ))}
      {/* Hang-aligned, so its text starts where every other line of the form
          does rather than a button's padding to the right of it. */}
      <Button
        className="-ml-2"
        onClick={() => {
          onChange([...values, ""]);
        }}
      >
        {addLabel}
      </Button>
    </div>
  );
}
