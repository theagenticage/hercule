import { readErrorMessage } from "@hercule/client-core";

/**
 * Returns the message of `error` without the full stops at its end, so a
 * sentence can go on after it ("... was not linked: <reason>. Try again.").
 */
export const readReason = (error: unknown): string => readErrorMessage(error).replace(/\.+$/, "");
