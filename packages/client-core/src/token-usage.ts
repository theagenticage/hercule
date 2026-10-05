/**
 * Reads a Token Usage record (spec 06 section 6.6) the way every screen
 * shows it.
 */
import type { Usage } from "@hercule/contract";

/**
 * Returns the number of tokens a Token Usage record counts: input, output,
 * cache reads and cache writes added up. The four parts never overlap, so
 * their sum is the tokens used. A part the harness does not report counts
 * as none.
 */
export const countUsedTokens = (usage: Usage): number =>
  usage.inputTokens +
  usage.outputTokens +
  (usage.cacheReadTokens ?? 0) +
  (usage.cacheWriteTokens ?? 0);
