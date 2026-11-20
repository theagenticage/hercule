/**
 * Removes credential values from the text an outside MCP server sent back, so
 * that a server that echoes its request, in an error or in a result, never
 * hands the Connection's token on to the harness (spec 13: no vendor token
 * reaches a runner).
 */

/** What replaces a credential value that was found. */
export const REMOVED_CREDENTIAL = "[removed]";

/**
 * Returns `value` with every occurrence of each of `secrets` replaced by
 * `REMOVED_CREDENTIAL` in every string it holds, at any depth of its arrays
 * and objects. Object keys are left alone. Returns `value` itself when
 * nothing was found, and otherwise copies only what changed, keeping the
 * prototype of each copied object, so a class instance stays one.
 *
 * A longer secret is replaced before a shorter one, so a header value such as
 * `Bearer abc123xyz` goes whole even when `abc123xyz` is also a secret.
 */
export const removeCredentialValues = <A>(value: A, secrets: ReadonlySet<string>): A => {
  if (secrets.size === 0) return value;
  const ordered = [...secrets].sort((left, right) => right.length - left.length);
  const clean = (item: unknown): unknown => {
    if (typeof item === "string") {
      return ordered.reduce((text, secret) => text.replaceAll(secret, REMOVED_CREDENTIAL), item);
    }
    if (Array.isArray(item)) {
      const cleaned = item.map(clean);
      return cleaned.some((entry, index) => entry !== item[index]) ? cleaned : item;
    }
    if (typeof item === "object" && item !== null) {
      const entries = Object.entries(item);
      const cleaned = entries.map(([key, entry]) => [key, clean(entry)] as const);
      if (cleaned.every(([, entry], index) => entry === entries[index]?.[1])) return item;
      const prototype = Object.getPrototypeOf(item) as object | null;
      return Object.assign(Object.create(prototype), Object.fromEntries(cleaned));
    }
    return item;
  };
  return clean(value) as A;
};
