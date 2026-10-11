/**
 * Full-text search over the database's FTS5 indexes. Every search in the
 * controller turns the caller's words into a `MATCH` expression here, so all
 * of them treat the same text the same way.
 */

/**
 * Builds the `MATCH` expression for a caller's plain words.
 *
 * - Every token is quoted, so `AND`, `OR` and a stray bracket are search terms
 *   rather than syntax.
 * - Tokens are joined with `AND`, so each extra word narrows the search, as a
 *   search box suggests.
 * - The text is split on everything that is not a letter or a digit, so no
 *   token contains a character that needs escaping.
 *
 * Returns `undefined` when the text contains no word at all. The index holds
 * no punctuation either, so such a search can match nothing.
 */
export const buildMatchExpression = (text: string): string | undefined => {
  const tokens = text.split(/[^\p{L}\p{N}]+/u).filter((token) => token.length > 0);
  return tokens.length === 0 ? undefined : tokens.map((token) => `"${token}"`).join(" AND ");
};
