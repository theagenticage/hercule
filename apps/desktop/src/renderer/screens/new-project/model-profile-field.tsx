import type { JSX } from "react";
import type { ModelProfile } from "@hercule/contract";
import { LabelledField } from "../step";

/**
 * Renders the New project form's Model profile select: None, which is the
 * default, then each of `profiles` by name. `value` is the id of the chosen
 * profile, or "" for None. `onChange` is called with the new value. The select
 * is `disabled` once the project exists, because the form then never changes
 * the project. `error` is the reason the controller refused the profile, shown
 * under the field, or `null`.
 *
 * The form shows this field only when the user has two or more profiles,
 * since with one there is nothing to choose.
 */
export function ModelProfileField({
  profiles,
  value,
  disabled,
  error,
  onChange,
}: {
  readonly profiles: readonly ModelProfile[];
  readonly value: string;
  readonly disabled: boolean;
  readonly error: string | null;
  readonly onChange: (modelProfileId: string) => void;
}): JSX.Element {
  return (
    <LabelledField
      label="Model profile"
      aside={<span className="fine new-project-optional">optional</span>}
      hint="New threads start on this profile. None uses your thread default."
      error={error}
    >
      <span className="field field--select">
        <select
          value={value}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
        >
          <option value="">None</option>
          {profiles.map((profile) => (
            <option key={profile.id} value={profile.id}>
              {profile.name}
            </option>
          ))}
        </select>
      </span>
    </LabelledField>
  );
}
