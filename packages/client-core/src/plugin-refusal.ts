/**
 * Returns why the controller refused to load a plugin, as a sentence. The raw
 * reasons (a host API version, a capability name, a schema error) mean little
 * to a user on their own, so this function turns each into a sentence a
 * person can act on.
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
