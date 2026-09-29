/**
 * Decides whether an address that came from outside the product may be shown
 * as a link.
 */

/**
 * Checks that `url` is an absolute `http:` or `https:` address. Returns false
 * for any other scheme, such as `data:` or `file:`, and for text that does not
 * parse as an absolute URL.
 *
 * An event's `url` is any text a plugin or an agent's `event.enrich` wrote, so
 * a page links it only when this check passes. Otherwise a link that reads
 * "Open" could lead to a `data:` page made to look like a login form.
 */
export const isWebLink = (url: string): boolean => {
  try {
    const { protocol } = new URL(url);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
};
