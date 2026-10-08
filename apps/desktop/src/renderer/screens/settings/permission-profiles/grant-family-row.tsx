import type { JSX } from "react";
import { formatGrantVerb, GRANT_FAMILY_TEXT, type GrantChange } from "@hercule/client-core";
import { GRANT_FAMILIES, type Grant, type GrantFamily } from "@hercule/contract";
import { CheckIcon } from "../../../icons/check";
import { SettingRow } from "../setting-row";
import "./permission-profiles.css";

/**
 * Renders the row of one grant family: its label and what it covers, and a
 * toggle button for each of its verbs. Any number of verbs may be pressed. A
 * pressed verb is a grant in `heldGrants`, and its button shows a check.
 *
 * Pressing a verb calls `onToggle` with the grant and whether the profile is
 * to hold it afterwards. `error` is shown under the row.
 */
export function GrantFamilyRow({
  family,
  heldGrants,
  error,
  onToggle,
}: {
  readonly family: GrantFamily;
  readonly heldGrants: ReadonlySet<Grant>;
  readonly error: string | null;
  readonly onToggle: (change: GrantChange) => void;
}): JSX.Element {
  const { label, hint } = GRANT_FAMILY_TEXT[family];
  return (
    <SettingRow
      label={label}
      hint={hint}
      error={error}
      control={(labels) => (
        <div className="profile-verbs" role="group" {...labels}>
          {(GRANT_FAMILIES[family] as ReadonlyArray<string>).map((verb) => {
            const grant = `${family}.${verb}` as Grant;
            const pressed = heldGrants.has(grant);
            return (
              <button
                key={verb}
                type="button"
                aria-pressed={pressed}
                title={grant}
                onClick={() => {
                  onToggle({ grant, held: !pressed });
                }}
              >
                <CheckIcon size={12} />
                {formatGrantVerb(verb)}
              </button>
            );
          })}
        </div>
      )}
    />
  );
}
