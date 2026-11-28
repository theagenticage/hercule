/**
 * The access-mode fallback (spec 06 §8.4). When a harness declares a mode
 * `unsupported`, a session asking for it runs in the nearest less permissive
 * mode the harness declares `native`, never in a more permissive one.
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
 * harness, so there is no mode to fall back to.
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

/** The names the Bureau book gives the modes. */
const LABELS: Readonly<Record<AccessMode, string>> = {
  "approval-required": "Approval required",
  "auto-accept-edits": "Auto-accept edits",
  auto: "Auto",
  "full-access": "Full access",
};

/**
 * Returns an access mode's name as the user reads it, such as "Auto-accept
 * edits" for `auto-accept-edits`. Every screen shows this name. The raw value
 * is the wire value: controls keep it as their value, and the CLI prints it.
 * It lives here, not in the client library, so the controller and the CLI can
 * use it too.
 */
export const formatAccessMode = (mode: AccessMode): string => LABELS[mode];

/**
 * Returns the sentence that tells the user a session runs in a different
 * access mode than the one it asked for, such as "Runs in Auto-accept edits,
 * because this harness does not support Auto.".
 *
 * Call it only when `requested` and `granted` differ. The controller writes
 * the sentence as a Runtime Notice into the session's stream, and
 * `hercule session spawn` prints it, so both show the same words. It names no
 * harness because the CLI knows only the harness id, and the two lines must be
 * identical.
 */
export const describeAccessModeFallback = (requested: AccessMode, granted: AccessMode): string =>
  `Runs in ${formatAccessMode(granted)}, because this harness does not support ${formatAccessMode(requested)}.`;
