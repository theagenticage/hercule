/**
 * The access modes as the user reads them: each mode's name, and the access
 * mode menu.
 *
 * The menu lists the four access modes, always in the same order. A mode the
 * provider does not support is dimmed, with a note naming the mode it falls
 * back to. The fallback uses the same downward-only rule the controller uses
 * when it starts a session, `findNearestSupportedAccessMode`, so a mode the
 * menu shows as available is one the controller actually grants. Spec 06 §8.4
 * owns the fallback rule.
 */
import {
  ACCESS_MODE_CHAIN,
  findNearestSupportedAccessMode,
  type AccessMode,
  type DeclaredCapabilities,
} from "@hercule/contract";

export interface AccessModeMenuItem {
  readonly mode: AccessMode;
  /** The mode's name as the user reads it, from `formatAccessMode`. */
  readonly label: string;
  readonly meaning: string;
  readonly dimmed: string | null;
}

/** The names the Bureau book gives the modes. */
const LABELS: Readonly<Record<AccessMode, string>> = {
  "approval-required": "Approval required",
  "auto-accept-edits": "Auto-accept edits",
  auto: "Auto",
  "full-access": "Full access",
};

const MEANINGS: Readonly<Record<AccessMode, string>> = {
  "approval-required": "asks for every side-effecting action",
  "auto-accept-edits": "allows file edits, asks for the rest",
  auto: "lets a harness-side reviewer judge routine actions",
  "full-access": "allows everything",
};

/**
 * Returns an access mode's name as the user reads it, such as "Auto-accept
 * edits" for `auto-accept-edits`. Every screen shows this name. The raw value
 * is the wire value: controls keep it as their value, and the CLI prints it.
 */
export const formatAccessMode = (mode: AccessMode): string => LABELS[mode];

/** Returns the rows of the access mode menu, in order from the most asking mode to the least. */
export const buildAccessModeMenu = (
  declared: DeclaredCapabilities["accessModes"],
  /** The provider's display name, used in the dimmed note to say which harness falls back. */
  providerName: string,
): readonly AccessModeMenuItem[] =>
  ACCESS_MODE_CHAIN.map((mode) => {
    const fallback = findNearestSupportedAccessMode(mode, declared);
    const dimmed =
      fallback === undefined || fallback === mode
        ? null
        : `runs as ${formatAccessMode(fallback)} on ${providerName}`;
    return { mode, label: formatAccessMode(mode), meaning: MEANINGS[mode], dimmed };
  });
