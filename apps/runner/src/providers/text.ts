/**
 * Cutting what a harness wrote down to what the protocol will carry. One
 * module, because two adapters cutting the same vendor string to two different
 * lengths - or one of them not cutting at all - is a frame the runner cannot
 * encode, and that costs it its socket and every session on it.
 */
import { MAX_FACT_LENGTH, MAX_MESSAGE_LENGTH } from "@hydra/protocol";

/** An id, a name, a version: short by nature, and simply cut when it is not. */
export const fact = (value: string): string => value.slice(0, MAX_FACT_LENGTH);

/**
 * The same cut for the longer fields: free text a harness wrote, not an id. It
 * says where it cut, because a command read as whole is a command the user
 * approved something else than.
 */
export const text = (value: string): string =>
  value.length > MAX_MESSAGE_LENGTH ? `${value.slice(0, MAX_MESSAGE_LENGTH - 1)}…` : value;
