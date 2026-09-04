/**
 * UUIDv7 ids for every Hydra-owned entity.
 *
 * Ids are minted by the controller, stored as a 16-byte `BLOB` primary key, and
 * rendered as the canonical lowercase string everywhere they leave the database.
 *
 * The Event is the one exception in the system: its id is the integer log
 * position, and it never passes through this module.
 */

/** Mints a new id as the 16 bytes that go into the column. */
export const mintUuid = (): Uint8Array => new Uint8Array(Bun.randomUUIDv7("buffer"));

/** Renders stored bytes as the canonical lowercase string. */
export const uuidToString = (bytes: Uint8Array): string => {
  if (bytes.length !== 16) {
    throw new TypeError(`A Hydra id is 16 bytes, got ${bytes.length}`);
  }
  let hex = "";
  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, "0");
  }
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

/**
 * The one shape an id has: a canonical lowercase UUIDv7, the same pattern the
 * contract's `Id` puts on the wire. Anything that has to check an id before
 * `uuidFromString` sees it - a decoded cursor, say - tests against this, so
 * there is one answer to what an id is.
 */
export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/**
 * Parses the canonical string back into the 16 bytes the column holds. Throws
 * on anything else: every caller has already validated the id, at the contract
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
