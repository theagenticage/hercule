/**
 * How this plugin fits text it copies from Linear into the limits the host
 * checks. Linear sets no useful bound on a title, a description or a comment,
 * and an event the host refuses would stay in a feed's outbox and stop every
 * later poll, so every such string is cut where a payload is built.
 */
import { MAX_BLOCK_NAME_LENGTH } from "@hercule/plugin-host";

/** The longest issue, project or document title the plugin copies. */
export const MAX_TITLE_LENGTH = 512;

/** The longest description or comment body the plugin copies. */
export const MAX_BODY_LENGTH = 16_384;

/** The longest short text the plugin copies: a name, a key, a label. */
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

/** Cuts a short text, such as a name, to `MAX_NAME_LENGTH`. */
export const cutName = (text: string): string => cutText(text, MAX_NAME_LENGTH);
