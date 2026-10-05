/**
 * How a client shows the status of a session's input. The rule lives here
 * with a test rather than in each client that lists inputs.
 */
import type { InputStatus } from "@hercule/contract";

/**
 * Returns the words for an input's status. Every status reads as its own
 * name, except `sent`: the input left the controller and the runner never
 * confirmed it, so it reads "sent, not confirmed". The bare word "sent"
 * would suggest the runner took the input, which nobody knows.
 */
export const describeInputStatus = (status: InputStatus): string =>
  status === "sent" ? "sent, not confirmed" : status;
