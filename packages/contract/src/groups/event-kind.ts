/**
 * Event kinds: what a trigger can listen for. The core declares the kinds it
 * emits, and every running plugin declares the kinds its event sources emit.
 * The list is the complete catalog of kinds a trigger can use right now, and
 * it is short, so it has no filter and no paging.
 */
import { Schema } from "effect";
import * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint";
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup";
import { Forbidden, Internal, Unauthenticated } from "../errors";
import { Authenticated } from "../security";
import { EventKind } from "./event";

/** An event kind that the core or a running plugin declares, and that a trigger can listen for. */
export const DeclaredEventKind = Schema.Struct({
  kind: EventKind,
  description: Schema.String,
  /**
   * Whether a trigger on this kind must set a Connection: a Connection id or
   * `any`. A plugin's events arrive through a Connection; the core's do not.
   */
  connectionRequired: Schema.Boolean,
});

export type DeclaredEventKind = Schema.Schema.Type<typeof DeclaredEventKind>;

export const eventKind = HttpApiGroup.make("eventKind")
  .add(
    HttpApiEndpoint.get("query", "/event-kinds", {
      success: Schema.Array(DeclaredEventKind),
      error: [Unauthenticated, Forbidden, Internal],
    }),
  )
  .middleware(Authenticated);
