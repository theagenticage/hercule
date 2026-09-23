/**
 * How the product shows a record that has no name, such as a session.
 *
 * An id is a UUIDv7 that nobody reads in full, so screens show only its last
 * characters (its tail). The tail has the same length the CLI accepts as a
 * tail (`MIN_TAIL`), so what a screen shows can be typed back at the command
 * line. The rule lives here with a test rather than as a bare `-8` inside a
 * component.
 */

/** How many characters of an id the tail keeps. */
export const ID_TAIL = 8;

/** Returns the tail of an id: the part the product shows and the CLI accepts. */
export const toIdTail = (id: string): string => id.slice(-ID_TAIL);
