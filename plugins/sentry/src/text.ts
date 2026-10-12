/**
 * How this plugin fits text it copies from Sentry into the limits the host
 * checks. Sentry sets no bound on a title, an exception message or a file
 * name, and an event the host refuses would stay in the feed's outbox and
 * stop every later poll, so every such string is cut where a payload is built.
 */
import { MAX_BLOCK_NAME_LENGTH, MAX_EVENT_TITLE_LENGTH } from "@hercule/plugin-host";

/** The longest issue title or culprit the plugin copies. */
export const MAX_TITLE_LENGTH = MAX_EVENT_TITLE_LENGTH;

/** The longest exception message the plugin copies. */
export const MAX_EXCEPTION_VALUE_LENGTH = 4096;

/**
 * The longest short text the plugin copies: a name, a release, an environment,
 * an error type, a file name, a function name.
 */
export const MAX_NAME_LENGTH = MAX_BLOCK_NAME_LENGTH;

/**
 * Cuts text to `maximum` characters, ending it with an ellipsis when it was
 * cut. Never leaves half of a surrogate pair (an emoji) at the cut.
 */
export const cutText = (text: string, maximum: number): string => {
  if (text.length <= maximum) return text;
  const end = maximum - 1;
  const lastUnit = text.charCodeAt(end - 1);
  const splitsPair = lastUnit >= 0xd800 && lastUnit <= 0xdbff;
  return `${text.slice(0, splitsPair ? end - 1 : end)}…`;
};

/** Cuts a short text, such as a name or a release, to `MAX_NAME_LENGTH`. */
export const cutName = (text: string): string => cutText(text, MAX_NAME_LENGTH);
