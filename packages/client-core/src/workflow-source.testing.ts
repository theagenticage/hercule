/**
 * What the suites that place problems in a workflow's source share: client-core's
 * own and the web app's, through the `@hercule/client-core/workflow-source/testing`
 * export. A helper written in each suite drifts.
 */

/**
 * The offset of a fragment that the source holds exactly once. A fragment that
 * occurs twice would make the expected place a guess.
 */
export const findUniqueOffset = (source: string, fragment: string): number => {
  const first = source.indexOf(fragment);
  if (first === -1 || source.indexOf(fragment, first + 1) !== -1) {
    throw new Error(`The source does not hold ${JSON.stringify(fragment)} exactly once.`);
  }
  return first;
};
