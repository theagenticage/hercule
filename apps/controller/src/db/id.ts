/**
 * UUIDv7 ids for every Hydra-owned entity (spec 04, Truth model).
 *
 * Ids are minted by the controller, stored as a 16-byte `BLOB` primary key, and
 * rendered as the canonical lowercase string everywhere they leave the database.
 * The short form a human sees is the last eight hex characters: the head of a
 * UUIDv7 is a millisecond timestamp shared by every id minted in the same
 * moment, so only the tail distinguishes them.
 *
 * The Event is the one exception in the system: its id is the integer log
 * position, and it never passes through this module.
 */
import * as Schema from "effect/Schema";

const CANONICAL = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** The canonical lowercase string form of a Hydra id, as it crosses the API. */
export const UuidString = Schema.String.check(Schema.isUUID(7), Schema.isLowercased());

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
 * Parses the canonical string form back into stored bytes. Callers validate
 * untrusted input with {@link UuidString} first; a malformed string here is a
 * programmer error, not a user error.
 */
export const uuidFromString = (id: string): Uint8Array => {
  if (!CANONICAL.test(id)) {
    throw new TypeError(`Not a canonical lowercase UUIDv7: ${id}`);
  }
  const hex = id.replaceAll("-", "");
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 16; i++) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
};

/** The short form shown in the web app and accepted by the CLI: the last eight hex characters. */
export const shortUuid = (id: Uint8Array | string): string =>
  (typeof id === "string" ? id : uuidToString(id)).slice(-8);
