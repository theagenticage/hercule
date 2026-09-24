/**
 * Why a plugin was turned away, as a sentence. None of the three reasons means
 * anything on its own - a version the user never chose, a capability name, a
 * schema complaint - so turning each into something a person can act on is a
 * reading of the domain, and lives here with a test.
 */
import type { PluginRefusalReason } from "@hercule/contract";

export const describeRefusalReason = (reason: PluginRefusalReason): string => {
  if (reason.kind === "hostApi") {
    return `Built against host API ${String(reason.actual)}; this controller speaks ${String(reason.expected)}.`;
  }
  if (reason.kind === "unimplementedCapability") {
    return `Asks for the ${reason.capability} capability, which this controller does not implement.`;
  }
  return `Its configuration schema cannot be rendered: ${reason.message}`;
};
