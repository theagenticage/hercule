/** Joins the class names with spaces, leaving out the ones that are `false`, `undefined` or empty. */
export const joinClassNames = (...names: readonly (string | false | undefined)[]): string =>
  names.filter((name) => name !== false && name !== undefined && name !== "").join(" ");
