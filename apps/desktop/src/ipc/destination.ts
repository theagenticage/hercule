/**
 * Builds the key that tells destinations apart. Main and the renderer both
 * need it, so it lives beside the IPC contract, and it imports the contract's
 * types only: the renderer links this file without Effect Schema.
 */
import type { Destination } from "./contract";

/**
 * Returns a string that is the same for two equal destinations and different
 * for any two others, such as `thread:<sessionId>` or
 * `assistant:<assistantId>`. A thread and an assistant with the same id get
 * different keys.
 */
export const buildDestinationKey = (destination: Destination): string => {
  switch (destination.kind) {
    case "thread":
      return `thread:${destination.sessionId}`;
    case "assistant":
      return `assistant:${destination.assistantId}`;
  }
};
