import type { JSX } from "react";
import { listTimezoneChoices } from "@hercule/client-core";
import { Select } from "@hercule/ui";

/**
 * The timezone control, shared by the onboarding step and Settings > Profile.
 *
 * The list offers only the zones this browser supports, because formatting a
 * time in an unsupported IANA zone throws. A stored zone that is not on the
 * list is added to it, so the field shows the actual setting rather than a
 * different zone. That way a value set elsewhere can be confirmed or
 * corrected here.
 */
export function TimezoneField({
  value,
  onChange,
}: {
  readonly value: string;
  readonly onChange: (timezone: string) => void;
}): JSX.Element {
  const zones = listTimezoneChoices(value);
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
