/** No card ids. One value, so a state that holds none compares equal by identity. */
export const NO_IDS: ReadonlySet<string> = new Set();

/** Returns the ids of `before` with `more` added, or `before` itself when `more` adds nothing. */
export const addIds = (
  before: ReadonlySet<string>,
  more: readonly string[],
): ReadonlySet<string> =>
  more.every((id) => before.has(id)) ? before : new Set([...before, ...more]);
