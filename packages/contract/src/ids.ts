/**
 * The shared wire vocabulary: ids, timestamps and the actor stamp.
 */
import { Schema } from "effect";

/**
 * A canonical lowercase UUIDv7 string: what every Hydra id looks like on the
 * wire. Event ids are integers and are not this schema.
 */
export const Id = Schema.String.check(
  Schema.isPattern(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/, {
    title: "uuidv7",
    description: "a canonical lowercase UUIDv7",
  }),
);

export type Id = Schema.Schema.Type<typeof Id>;

/** An instant on the wire: ISO-8601 UTC with milliseconds. */
export const Timestamp = Schema.String.check(
  Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/, {
    title: "timestamp",
    description: "an ISO-8601 UTC instant with milliseconds",
  }),
);

export type Timestamp = Schema.Schema.Type<typeof Timestamp>;

/**
 * Who performed an operation. Derived from the
 * credential, never supplied by the caller; widened when multi-user arrives,
 * never restructured.
 */
export const Actor = Schema.String.check(
  Schema.isPattern(
    /^(user|(session|run):[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|plugin:[a-z0-9][a-z0-9-]*)$/,
    {
      title: "actor",
      description: "`user`, `session:<id>`, `run:<id>` or `plugin:<id>`",
    },
  ),
);

export type Actor = Schema.Schema.Type<typeof Actor>;
