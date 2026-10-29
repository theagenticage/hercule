/** Helpers for the timestamp, the error messages and the text in the runner's own frames. */
import * as Cause from "effect/Cause";

/** Returns the current time on this machine as an ISO-8601 string. */
export const now = (): string => new Date().toISOString();

/** Returns the message of an error, or the value itself as text. */
export const describeError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** Returns `text` with a period at its end, unless it already has one. */
export const endSentence = (text: string): string => (text.endsWith(".") ? text : `${text}.`);

/**
 * Returns the first line of a failure's description, cut to `limit`
 * characters to fit the frame field it is sent in. Never returns an empty
 * string: the runner must always report a failure, or the controller would
 * wait until its deadline for a reply the runner could have sent at once.
 */
export const describeCause = (cause: Cause.Cause<unknown>, limit: number): string =>
  (Cause.pretty(cause).split("\n")[0] ?? "").slice(0, limit) || "the runner could not answer";

/**
 * Returns `text` with each control character written as `\u{...}`. These are
 * the control characters, the line and paragraph separators, and the Unicode
 * format characters such as the bidirectional overrides: the same ones an
 * `EditedFile` path may not hold. Text that someone else controls would
 * otherwise carry line breaks or direction marks into a client's screen.
 */
export const escapeControlCharacters = (text: string): string =>
  text.replace(
    /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu,
    (character) => `\\u{${(character.codePointAt(0) ?? 0).toString(16)}}`,
  );
