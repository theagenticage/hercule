/**
 * The answer to the question the events domain asks about event kinds.
 *
 * The events domain must be able to read a kind's payload schema and the bare
 * id of the plugin that owns it, and the plugins domain already appends audit
 * entries to the event log, so an import the other way would close a cycle. The
 * question is declared over there as `EventKindCatalog`; this is the plugins
 * domain answering it, from what the boot's registration pass registered.
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
      Effect.map(host.eventKinds(), (kinds) => Option.fromNullishOr(kinds.get(kind))),
  })),
);
