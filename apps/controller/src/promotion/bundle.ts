/**
 * The format of a promotion transfer: what the old controller streams and the
 * new machine reads back. In order:
 *
 * - 4 bytes: the ASCII magic `HCL1`, so a JSON error body is recognized at once;
 * - 4 bytes: the length of the header, big-endian;
 * - the header, as JSON;
 * - the database copy;
 * - each attachment file, in header order.
 *
 * The format is not a public API payload. The caller holds a promotion token,
 * not a user credential, and only `hercule promote` reads it.
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { Id } from "@hercule/contract";

const MAGIC = new TextEncoder().encode("HCL1");

/** Where the header starts: after the magic and the header length. */
const HEADER_START = MAGIC.byteLength + 4;

/** The only format version this build writes and reads. */
export const TRANSFER_FORMAT_VERSION = 1;

const ByteLength = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

/** The header that precedes the database copy. */
export const TransferHeader = Schema.Struct({
  formatVersion: Schema.Literal(TRANSFER_FORMAT_VERSION),
  controllerId: Id,
  /** The schema version of the database copy, so the new machine can refuse one it does not know. */
  schemaVersion: Schema.Int,
  /** The 32-byte HKDF salt of the transfer key, base64url. */
  salt: Schema.NonEmptyString,
  databaseByteLength: ByteLength,
  /** Each attachment file that follows the database, by attachment id, which is also its file name. */
  attachments: Schema.Array(Schema.Struct({ id: Id, byteLength: ByteLength })),
});

export type TransferHeader = Schema.Schema.Type<typeof TransferHeader>;

/** A transfer that does not match this format, or a file of it that could not be read. */
export class TransferBundleError extends Schema.TaggedError<TransferBundleError>()(
  "TransferBundleError",
  { message: Schema.String },
) {}

/** A part of a transfer file, as the byte range `[start, end)`. */
export interface ByteRange {
  readonly start: number;
  readonly end: number;
}

/** A transfer file, read: its header, and where the database and each attachment sit in it. */
export interface TransferLayout {
  readonly header: TransferHeader;
  readonly database: ByteRange;
  readonly attachments: ReadonlyArray<ByteRange & { readonly id: string }>;
}

/** Encodes the magic, the header length and the header that precede the database bytes. */
const encodeTransferHeader = (header: TransferHeader): Uint8Array => {
  const json = new TextEncoder().encode(JSON.stringify(header));
  const out = new Uint8Array(HEADER_START + json.byteLength);
  out.set(MAGIC, 0);
  new DataView(out.buffer).setUint32(MAGIC.byteLength, json.byteLength);
  out.set(json, HEADER_START);
  return out;
};

/** Streams the file at `path` without holding it in memory. */
const streamFile = (path: string): Stream.Stream<Uint8Array, TransferBundleError> =>
  Stream.fromReadableStream({
    evaluate: () => Bun.file(path).stream(),
    onError: (cause) =>
      new TransferBundleError({ message: `could not read ${path}: ${String(cause)}` }),
  });

/**
 * Streams a transfer: the header, then the file at `databasePath`, then each
 * file in `attachmentPaths`, which must be in the order of
 * `header.attachments`. Fails with `TransferBundleError` when a file cannot be
 * read.
 */
export const streamTransfer = (
  header: TransferHeader,
  databasePath: string,
  attachmentPaths: ReadonlyArray<string>,
): Stream.Stream<Uint8Array, TransferBundleError> =>
  Stream.concat(
    Stream.succeed(encodeTransferHeader(header)),
    Stream.flatMap(Stream.fromIterable([databasePath, ...attachmentPaths]), streamFile),
  );

const NOT_A_TRANSFER =
  "the response is not a promotion transfer. Check that the URL is the old Hercule " +
  "controller and that the token is a promotion token";

/** Reads the bytes `[start, end)` of the file at `path`. */
const readRange = (path: string, start: number, end: number) =>
  Effect.tryPromise({
    try: async () => new Uint8Array(await Bun.file(path).slice(start, end).arrayBuffer()),
    catch: (cause) =>
      new TransferBundleError({ message: `could not read ${path}: ${String(cause)}` }),
  });

/**
 * Reads the header of the transfer saved at `path` and returns where each part
 * sits in the file. Fails with `TransferBundleError` when the file is not a
 * transfer in this format, or when its length is not exactly what the header
 * accounts for, as with a transfer that broke off.
 */
export const readTransferLayout = (
  path: string,
): Effect.Effect<TransferLayout, TransferBundleError> =>
  Effect.gen(function* () {
    const size = Bun.file(path).size;
    const prefix = yield* readRange(path, 0, HEADER_START);
    if (prefix.byteLength < HEADER_START || MAGIC.some((byte, i) => prefix[i] !== byte)) {
      return yield* new TransferBundleError({ message: NOT_A_TRANSFER });
    }
    const headerEnd = HEADER_START + new DataView(prefix.buffer).getUint32(MAGIC.byteLength);
    if (headerEnd > size) {
      return yield* new TransferBundleError({ message: "the promotion transfer broke off" });
    }
    const json = new TextDecoder().decode(yield* readRange(path, HEADER_START, headerEnd));
    const header = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(TransferHeader))(
      json,
    ).pipe(
      Effect.mapError(
        () =>
          new TransferBundleError({
            message:
              "the promotion transfer header is not one this build can read. Run the same " +
              "Hercule version on both machines",
          }),
      ),
    );

    const database = { start: headerEnd, end: headerEnd + header.databaseByteLength };
    let offset = database.end;
    const attachments = header.attachments.map(({ id, byteLength }) => {
      const range = { id, start: offset, end: offset + byteLength };
      offset = range.end;
      return range;
    });
    if (offset !== size) {
      return yield* new TransferBundleError({
        message:
          offset > size
            ? "the promotion transfer broke off"
            : "the promotion transfer has more bytes than its header accounts for",
      });
    }
    return { header, database, attachments };
  });
