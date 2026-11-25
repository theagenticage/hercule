/**
 * Explains, for a person, why the vendored client refused something the
 * harness sent: which message, which field, and what the field held. It
 * imports nothing from the vendored client: `connection.ts` passes in the
 * schema to decode with and the function that quotes harness text.
 */
import * as Schema from "effect/Schema";
import * as SchemaIssue from "effect/SchemaIssue";

const SYNC_ADVICE = "Sync packages/acp/vendor with T3 Code (packages/acp/README.md).";

/** Who started a message: the harness sent it, or it answers a call of ours. */
export type Sender = "sent" | "answered";

/** Writes a path as people write it: `toolCall.kind`, or `configOptions[3]`. */
const formatPath = (path: ReadonlyArray<PropertyKey>): string =>
  path
    .map((key, index) =>
      typeof key === "number" ? `[${key}]` : `${index === 0 ? "" : "."}${String(key)}`,
    )
    .join("");

/** Returns the value at `path` in `payload`, or `undefined` when the path leads nowhere. */
const readAtPath = (payload: unknown, path: ReadonlyArray<PropertyKey>): unknown =>
  path.reduce<unknown>(
    (value, key) =>
      typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined,
    payload,
  );

/**
 * Returns a sentence that says the harness sent `method` with a value this
 * version cannot read, shows `detail` as `quote` renders it, and gives the
 * advice to sync the vendored copy.
 */
export const describeUnreadable = (options: {
  readonly sender: Sender;
  readonly method: string;
  readonly detail: string;
  readonly quote: (text: string) => string;
}): string =>
  `The harness ${options.sender} ${options.method} with a value this version cannot read: ${options.quote(options.detail)}. ${SYNC_ADVICE}`;

const formatIssue = SchemaIssue.makeFormatterStandardSchemaV1();

/**
 * Returns a `describeUnreadable` sentence that names the first field of
 * `payload` that `schema` refuses, and its value. Returns `undefined` when
 * `schema` accepts `payload`, or refuses it in a way that names no field.
 */
export const describeRefusal = (options: {
  readonly sender: Sender;
  readonly method: string;
  readonly schema: Schema.Decoder<unknown>;
  readonly payload: unknown;
  readonly quote: (text: string) => string;
}): string | undefined => {
  const exit = Schema.decodeUnknownExit(options.schema)(options.payload);
  if (exit._tag === "Success") return undefined;
  const failure = exit.cause.reasons.find((reason) => reason._tag === "Fail");
  if (failure === undefined || !(failure.error instanceof Schema.SchemaError)) return undefined;
  const path = (formatIssue(failure.error.issue).issues[0]?.path ?? []).map((segment) =>
    typeof segment === "object" ? segment.key : segment,
  );
  const value = readAtPath(options.payload, path);
  const where = path.length === 0 ? "the message" : formatPath(path);
  const what = value === undefined ? "is missing" : `is ${JSON.stringify(value)}`;
  return describeUnreadable({ ...options, detail: `${where} ${what}` });
};
