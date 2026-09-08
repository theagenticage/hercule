/**
 * The four access modes, in the one order they are ever shown, with the
 * downward-only fallback of spec 06 §8.4. `approval-required` sits at the
 * floor of that chain, so it is the fallback everything else lands on and
 * never dims itself, whatever a provider declares about it.
 */
import type { AccessMode, DeclaredCapabilities } from "@hydra/contract";

export interface AccessModeMenuItem {
  readonly mode: AccessMode;
  readonly meaning: string;
  readonly dimmed: string | null;
}

/** Least to most permissive - the order the fallback walks down. */
const CHAIN: readonly AccessMode[] = [
  "approval-required",
  "auto-accept-edits",
  "auto",
  "full-access",
];

const MEANINGS: Readonly<Record<AccessMode, string>> = {
  "approval-required": "asks for every side-effecting action",
  "auto-accept-edits": "allows file edits, asks for the rest",
  auto: "lets a harness-side reviewer judge routine actions",
  "full-access": "allows everything",
};

export const accessModeMenu = (
  declared: DeclaredCapabilities["accessModes"],
): readonly AccessModeMenuItem[] =>
  CHAIN.map((mode, rank) => {
    if (mode === "approval-required" || declared[mode] === "native") {
      return { mode, meaning: MEANINGS[mode], dimmed: null };
    }
    let fallback: AccessMode = "approval-required";
    for (let below = rank - 1; below >= 0; below--) {
      const candidate = CHAIN[below]!;
      if (candidate === "approval-required" || declared[candidate] === "native") {
        fallback = candidate;
        break;
      }
    }
    return { mode, meaning: MEANINGS[mode], dimmed: `runs as ${fallback} on this provider` };
  });
