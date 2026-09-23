/**
 * Test helpers shared by the client-core and web app tests of issue ranges.
 * The web app imports them from `@hercule/client-core/workflow-source/testing`.
 */

/**
 * Returns the offset of `fragment` in `source`. Throws unless the fragment
 * occurs exactly once, because a second match would make the expected offset
 * ambiguous.
 */
export const findUniqueOffset = (source: string, fragment: string): number => {
  const first = source.indexOf(fragment);
  if (first === -1 || source.indexOf(fragment, first + 1) !== -1) {
    throw new Error(`The source does not hold ${JSON.stringify(fragment)} exactly once.`);
  }
  return first;
};
