/**
 * The four access modes, in the one order they are ever shown, dimmed by the
 * same downward-only fallback the controller spawns on (`nearestSupportedAccessMode`,
 * spec 06 §8.4) - so a mode this menu shows as available is a mode the
 * controller will actually grant.
 */
import {
  nearestSupportedAccessMode,
  type AccessMode,
  type DeclaredCapabilities,
} from "@hydra/contract";

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

export const accessModeMenu = (
  declared: DeclaredCapabilities["accessModes"],
): readonly AccessModeMenuItem[] =>
  (["approval-required", "auto-accept-edits", "auto", "full-access"] as const).map((mode) => {
    const fallback = nearestSupportedAccessMode(mode, declared);
    const dimmed =
      fallback === undefined || fallback === mode ? null : `runs as ${fallback} on this provider`;
    return { mode, meaning: MEANINGS[mode], dimmed };
  });
