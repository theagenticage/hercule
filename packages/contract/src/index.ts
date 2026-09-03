import * as Schema from "effect/Schema";

/** Version of the public API surface this build speaks. */
export const API_VERSION = 1;

/** Response of the unauthenticated liveness probe. */
export const Health = Schema.Struct({
  status: Schema.Literal("ok"),
  apiVersion: Schema.Number,
});

export type Health = Schema.Schema.Type<typeof Health>;
