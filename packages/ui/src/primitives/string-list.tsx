import type { JSX } from "react";
import { Button } from "./button";
import { Input } from "./input";

/**
 * A list of short strings, one field per entry: a comma-separated box would
 * quietly refuse any value with a comma in it. An empty list shows no fields at
 * all, because a blank row would read as an entry already started. The group
 * carries the name, since there is no one field for a label to point at.
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
  /** Announced on the group: it is the list, not any one entry, being asked for. */
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
          does rather than a button's padding to the right of it. It is drawn in
          ink behind the same leading glyph the one other add affordance wears,
          because a muted word under a form reads as another field's name. */}
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
