/**
 * The answer to the questions the events domain asks about event kinds.
 *
 * The events domain must be able to read a kind's payload schema, and to list
 * the kinds a trigger can name, and the plugins domain already appends audit
 * entries to the event log, so an import the other way would close a cycle.
 * The questions are declared over there as `EventKindCatalog`; this is the
 * plugins domain answering them, from what the boot's registration pass
 * registered.
 */
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { EventKindCatalog } from "../events";
import { PluginHost } from "./host";

export const EventKindCatalogLayer: Layer.Layer<EventKindCatalog, never, PluginHost> = Layer.effect(
  EventKindCatalog,
)(
  Effect.map(PluginHost, (host) => ({
    readPayloadSchema: (kind: string) =>
      Effect.map(host.eventKinds(), (kinds) =>
        Option.map(Option.fromNullishOr(kinds.get(kind)), (registered) => registered.schema),
      ),
    listActiveEventKinds: host.listActiveEventKinds,
  })),
);
