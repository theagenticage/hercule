/**
 * The access-mode fallback (spec 06 §8.4). When a provider declares a mode
 * `unsupported`, a session asking for it runs in the nearest less permissive
 * mode the provider declares `native`, never in a more permissive one.
 *
 * The controller uses this function when it spawns a session, and the
 * composer's menu uses it to dim modes. Because both use the same function,
 * the mode the menu shows as available is always the mode the controller
 * grants.
 */
import type { DeclaredCapabilities } from "@hercule/plugin-host";
import type { AccessMode } from "@hercule/protocol";

/** The access modes from least to most permissive. The fallback moves down this list. */
export const ACCESS_MODE_CHAIN: readonly AccessMode[] = [
  "approval-required",
  "auto-accept-edits",
  "auto",
  "full-access",
];

/**
 * Returns the mode a session actually gets when it asks for `requested`: the
 * nearest mode at or below `requested` that `declared` marks `native`.
 * Returns `undefined` when not even `approval-required` is native on this
 * provider, so there is no mode to fall back to.
 */
export const findNearestSupportedAccessMode = (
  requested: AccessMode,
  declared: DeclaredCapabilities["accessModes"],
): AccessMode | undefined => {
  for (let index = ACCESS_MODE_CHAIN.indexOf(requested); index >= 0; index -= 1) {
    const mode = ACCESS_MODE_CHAIN[index]!;
    if (declared[mode] === "native") return mode;
  }
  return undefined;
};
