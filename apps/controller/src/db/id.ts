/**
 * UUIDv7 ids for every Hercule-owned entity.
 *
 * Ids are minted by the controller, stored as a 16-byte `BLOB` primary key, and
 * rendered as the canonical lowercase string everywhere they leave the database.
 *
 * The Event is the one exception: its id is its integer position in the event
 * log, so it never uses this module.
 */

/** Creates a new id and returns it as the 16 bytes stored in the column. */
export const mintUuid = (): Uint8Array => new Uint8Array(Bun.randomUUIDv7("buffer"));

/** Converts stored bytes to the canonical lowercase string. Throws when there are not 16 bytes. */
export const uuidToString = (bytes: Uint8Array): string => {
  if (bytes.length !== 16) {
    throw new TypeError(`A Hercule id is 16 bytes, got ${bytes.length}`);
  }
  let hex = "";
  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, "0");
  }
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

/**
 * The format of a valid id: a canonical lowercase UUIDv7, the same pattern as
 * the contract's `Id`. Code that has to check an id before passing it to
 * `uuidFromString`, such as cursor decoding, tests against this pattern, so
 * every check agrees on what a valid id is.
 */
export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/**
 * Parses the canonical string into the 16 bytes stored in the column. Throws on
 * any other string: every caller has already validated the id, in the contract
 * or against `UUID_PATTERN`, so a failure here is a bug rather than bad input.
 */
export const uuidFromString = (id: string): Uint8Array => {
  if (!UUID_PATTERN.test(id)) {
    throw new TypeError(`Not a canonical lowercase UUID: ${JSON.stringify(id)}`);
  }
  const hex = id.replaceAll("-", "");
  const bytes = new Uint8Array(16);
  for (let index = 0; index < 16; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
};
