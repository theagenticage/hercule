/**
 * The downward-only access-mode fallback of spec 06 §8.4: a mode a provider
 * declares `unsupported` runs as the nearest less-permissive mode it does
 * declare `native`, never a more permissive one. The controller spawns on
 * this; the composer's menu dims on it - one function, so the mode the menu
 * offers as available is always the mode the controller will actually grant.
 */
import type { DeclaredCapabilities } from "@hercule/plugin-host";
import type { AccessMode } from "@hercule/protocol";

/** Least to most permissive - the order the fallback walks down. */
export const ACCESS_MODE_CHAIN: readonly AccessMode[] = [
  "approval-required",
  "auto-accept-edits",
  "auto",
  "full-access",
];

/**
 * The mode a spawn or a menu actually gets for `requested`: the nearest mode
 * at or below it that `declared` marks `native`. `undefined` means even
 * `approval-required` is not native on this provider, so there is nothing to
 * fall back to.
 */
export const nearestSupportedAccessMode = (
  requested: AccessMode,
  declared: DeclaredCapabilities["accessModes"],
): AccessMode | undefined => {
  for (let index = ACCESS_MODE_CHAIN.indexOf(requested); index >= 0; index -= 1) {
    const mode = ACCESS_MODE_CHAIN[index]!;
    if (declared[mode] === "native") return mode;
  }
  return undefined;
};
