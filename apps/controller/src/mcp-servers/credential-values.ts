/**
 * Removes credential values from the text an outside MCP server sent back, so
 * that a server that echoes its request, in an error, in a result or in a tool
 * definition, never hands the Connection's token on to the harness (spec 13:
 * no vendor token reaches a runner).
 */

/** What replaces a credential value that was found. */
export const REMOVED_CREDENTIAL = "[removed]";

/**
 * Returns `value` with every occurrence of each of `secrets` replaced by
 * `REMOVED_CREDENTIAL` in every string it holds, at any depth of its arrays
 * and objects, and in every object key. Returns `value` itself when nothing
 * was found, and otherwise copies only what changed, keeping the prototype of
 * each copied object, so a class instance stays one.
 *
 * A longer secret is replaced before a shorter one, so a header value such as
 * `Bearer abc123xyz` goes whole even when `abc123xyz` is also a secret.
 *
 * Two keys of one object can end up with the same name after their secrets
 * are removed. A key that held no secret keeps its name. A key that did gets
 * `-2`, `-3` and so on appended until its name is free, in the order of the
 * keys, so no entry is lost.
 */
export const removeCredentialValues = <A>(value: A, secrets: ReadonlySet<string>): A => {
  if (secrets.size === 0) return value;
  const ordered = [...secrets].sort((left, right) => right.length - left.length);
  const cleanText = (text: string): string =>
    ordered.reduce((cleaned, secret) => cleaned.replaceAll(secret, REMOVED_CREDENTIAL), text);
  const clean = (item: unknown): unknown => {
    if (typeof item === "string") return cleanText(item);
    if (Array.isArray(item)) {
      const cleaned = item.map(clean);
      return cleaned.some((entry, index) => entry !== item[index]) ? cleaned : item;
    }
    if (typeof item === "object" && item !== null) {
      const entries = Object.entries(item);
      const taken = new Set(entries.map(([key]) => key).filter((key) => cleanText(key) === key));
      const cleaned = entries.map(([key, entry]) => {
        const cleanedKey = cleanText(key);
        let unique = cleanedKey;
        for (let suffix = 2; cleanedKey !== key && taken.has(unique); suffix += 1) {
          unique = `${cleanedKey}-${String(suffix)}`;
        }
        taken.add(unique);
        return [unique, clean(entry)] as const;
      });
      const unchanged = cleaned.every(
        ([key, entry], index) => key === entries[index]?.[0] && entry === entries[index]?.[1],
      );
      if (unchanged) return item;
      // `Object.fromEntries` defines each key as plain data, so a key named
      // `__proto__` cannot change the copy's prototype the way assigning would.
      return Object.setPrototypeOf(
        Object.fromEntries(cleaned),
        Object.getPrototypeOf(item) as object | null,
      );
    }
    return item;
  };
  return clean(value) as A;
};
