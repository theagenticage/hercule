/**
 * How the product names a thing it has no name for.
 *
 * An id is a UUIDv7 nobody reads whole, so what is shown is its tail - the same
 * number of characters the CLI accepts as a tail (`MIN_TAIL`), so what a screen
 * prints is what can be typed back at the command line. That is a reading of
 * the domain, so it lives here with a test rather than as a bare `-8` inside a
 * component.
 */

/** How many characters of an id name it. */
export const ID_TAIL = 8;

/** The tail of an id: the part of it the product shows and the CLI accepts. */
export const toIdTail = (id: string): string => id.slice(-ID_TAIL);
