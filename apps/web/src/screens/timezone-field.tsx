import type { JSX } from "react";
import { supportedTimezones } from "@hercule/client-core";
import { Select } from "@hercule/ui";

/** The zones on offer never change within a page load, so they are read once. */
const ZONES = supportedTimezones();

/**
 * The timezone control, shared by the onboarding step and Settings > Profile.
 *
 * The list is closed: an IANA zone this browser cannot format throws wherever
 * a time is read, so the only zones on offer are the ones it knows. A zone
 * already stored that is not on the list is offered too, so the screen shows
 * what is set rather than a different zone - which is how a value written from
 * elsewhere gets confirmed or corrected here.
 */
export function TimezoneField({
  value,
  onChange,
}: {
  readonly value: string;
  readonly onChange: (timezone: string) => void;
}): JSX.Element {
  const zones = ZONES.includes(value) ? ZONES : [value, ...ZONES];
  return (
    <Select
      id="timezone"
      name="timezone"
      value={value}
      onChange={(event) => {
        onChange(event.target.value);
      }}
    >
      {zones.map((zone) => (
        <option key={zone} value={zone}>
          {zone}
        </option>
      ))}
    </Select>
  );
}
