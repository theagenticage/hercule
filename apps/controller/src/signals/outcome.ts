import { MAX_SIGNAL_OUTCOME_LENGTH } from "@hercule/contract";

/**
 * Returns an outcome line short enough for a resolution to store. A line
 * longer than `MAX_SIGNAL_OUTCOME_LENGTH` is cut and ends in "…", so the
 * reader sees it was cut. The cut never splits a character that takes two
 * UTF-16 code units, such as an emoji.
 */
export const truncateOutcome = (outcome: string): string => {
  if (outcome.length <= MAX_SIGNAL_OUTCOME_LENGTH) return outcome;
  let kept = outcome.slice(0, MAX_SIGNAL_OUTCOME_LENGTH - 1);
  const last = kept.charCodeAt(kept.length - 1);
  // A high surrogate is the first half of a two-unit character.
  if (last >= 0xd800 && last <= 0xdbff) kept = kept.slice(0, -1);
  return `${kept}…`;
};
