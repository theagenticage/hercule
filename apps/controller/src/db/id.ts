/**
 * UUIDv7 ids for every Hydra-owned entity (spec 04, Truth model).
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
