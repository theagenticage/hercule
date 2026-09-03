import * as Schema from "effect/Schema";

/** Version of the controller-runner WebSocket protocol this build speaks. */
export const PROTOCOL_VERSION = 1;

/** First frame a runner sends after dialing the controller. */
export const Hello = Schema.Struct({
  protocolVersion: Schema.Number,
  runnerId: Schema.String,
});

export type Hello = Schema.Schema.Type<typeof Hello>;
