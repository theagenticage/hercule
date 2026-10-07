/**
 * The choices and the words of an assistant's rotation as Settings >
 * Assistants shows it: "At 70% of the context or 200k tokens, and daily at
 * 04:00".
 */
import { addStoredChoice } from "./choices";

/** The shares of the context the rotation select offers. */
const CONTEXT_FRACTION_CHOICES = [0.5, 0.6, 0.7, 0.8, 0.9];

/** The context sizes, in tokens, the rotation select offers. */
const CONTEXT_TOKEN_CHOICES = [100_000, 200_000, 400_000, 1_000_000];

/**
 * Returns the shares of the context the select offers, in ascending order.
 * `stored`, the assistant's current `contextFraction`, is among them even
 * when it was set outside the app to a share the select does not offer, so
 * the select can show it.
 */
export const listContextFractionChoices = (stored: number): ReadonlyArray<number> =>
  addStoredChoice(CONTEXT_FRACTION_CHOICES, stored);

/**
 * Returns the context sizes, in tokens, the select offers, in ascending
 * order. `stored`, the assistant's current `maxContextTokens`, is among them
 * even when it is a size the select does not offer.
 */
export const listContextTokenChoices = (stored: number): ReadonlyArray<number> =>
  addStoredChoice(CONTEXT_TOKEN_CHOICES, stored);

/**
 * Formats a share of the context as a percentage: 0.7 is "70%". A share that
 * is not a whole percentage keeps one decimal, so 0.725 is "72.5%" and no
 * stored value is shown as a different one.
 */
export const formatContextFraction = (fraction: number): string =>
  `${String(Math.round(fraction * 1000) / 10)}%`;

/**
 * Formats a token limit the short way a select shows it: "950", "200k",
 * "1.5k", "1M", "1.5M". Thousands and millions keep one decimal, and only
 * when it is not zero.
 *
 * `formatTokenCount` always keeps the decimal ("200.0k"), which suits a
 * count that changes as a session runs, but not a limit the user picks.
 */
export const formatTokenLimit = (tokens: number): string => {
  if (tokens < 1000) return String(tokens);
  const thousands = Math.round(tokens / 100) / 10;
  if (thousands < 1000) return `${String(thousands)}k`;
  return `${String(Math.round(tokens / 100_000) / 10)}M`;
};
