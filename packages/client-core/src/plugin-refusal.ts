/**
 * Why a plugin was turned away, as a sentence.
 *
 * The three reasons carry different fields and none of them means anything on
 * its own: a version number the user never chose, a capability name, a schema
 * complaint. Turning each into the one thing a person can act on is a reading
 * of the domain, so it lives here with a test.
 */
import type { PluginRefusalReason } from "@hydra/contract";

export const refusalReason = (reason: PluginRefusalReason): string => {
  if (reason.kind === "hostApi") {
    return `Built against host API ${String(reason.actual)}; this controller speaks ${String(reason.expected)}.`;
  }
  if (reason.kind === "unimplementedCapability") {
    return `Asks for the ${reason.capability} capability, which this controller does not implement.`;
  }
  return `Its configuration schema cannot be rendered: ${reason.message}`;
};
