/**
 * Builds the access mode menu: the four access modes, always in the same
 * order. A mode the provider does not support is dimmed, with a note naming
 * the mode it falls back to. The fallback uses the same downward-only rule the
 * controller uses when it starts a session, `findNearestSupportedAccessMode`,
 * so a mode the menu shows as available is one the controller actually grants.
 * Spec 06 §8.4 owns the fallback rule.
 */
import {
  findNearestSupportedAccessMode,
  type AccessMode,
  type DeclaredCapabilities,
} from "@hercule/contract";

export interface AccessModeMenuItem {
  readonly mode: AccessMode;
  readonly meaning: string;
  readonly dimmed: string | null;
}

const MEANINGS: Readonly<Record<AccessMode, string>> = {
  "approval-required": "asks for every side-effecting action",
  "auto-accept-edits": "allows file edits, asks for the rest",
  auto: "lets a harness-side reviewer judge routine actions",
  "full-access": "allows everything",
};

export const buildAccessModeMenu = (
  declared: DeclaredCapabilities["accessModes"],
  /** The provider's display name, used in the dimmed note to say which harness falls back. */
  providerName: string,
): readonly AccessModeMenuItem[] =>
  (["approval-required", "auto-accept-edits", "auto", "full-access"] as const).map((mode) => {
    const fallback = findNearestSupportedAccessMode(mode, declared);
    const dimmed =
      fallback === undefined || fallback === mode ? null : `runs as ${fallback} on ${providerName}`;
    return { mode, meaning: MEANINGS[mode], dimmed };
  });
