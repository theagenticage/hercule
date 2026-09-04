import type { JSX } from "react";
import { supportedTimezones } from "@hydra/client-core";
import { Select } from "@hydra/ui";

/**
 * The timezone control, shared by the onboarding step and Settings > Profile.
 *
 * The list is closed: an IANA zone this browser cannot format throws wherever
 * a time is read, so the only zones on offer are the ones it knows. A zone
 * already stored that this browser does not know is offered too, so the screen
 * shows what is set rather than silently reading as a different zone - which is
 * how a value written from elsewhere gets corrected here.
 */
const ZONES = supportedTimezones();

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
