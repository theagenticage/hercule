/**
 * Cutting what a harness wrote down to what the protocol will carry. One
 * module, because two adapters cutting the same vendor string to two different
 * lengths - or one of them not cutting at all - is a frame the runner cannot
 * encode, and an event that will not encode is one the runner drops.
 */
import { MAX_FACT_LENGTH, MAX_MESSAGE_LENGTH } from "@hydra/protocol";

/** An id, a name, a version: short by nature, and simply cut when it is not. */
export const fact = (value: string): string => value.slice(0, MAX_FACT_LENGTH);

/**
 * The same cut, for an id something downstream is filed under. An id the
 * protocol will not carry is a frame nobody can decode, which loses the event
 * whole; a harness that named none gets one of ours instead, so what it was
 * about is still reported.
 */
export const idOf = (given: string): string => (given === "" ? crypto.randomUUID() : fact(given));

/**
 * The same cut for the longer fields: free text a harness wrote, not an id. It
 * says where it cut, because a command read as whole is a command the user
 * approved something else than.
 */
export const text = (value: string): string =>
  value.length > MAX_MESSAGE_LENGTH ? `${value.slice(0, MAX_MESSAGE_LENGTH - 1)}…` : value;
