/**
 * Implements the events domain's `EventKindCatalog` service from the event
 * kinds that plugins registered at boot.
 *
 * The events domain needs to read a kind's payload schema and to list the
 * kinds a trigger can use. It cannot import the plugins domain to do so,
 * because the plugins domain already imports the events domain to append
 * audit entries to the event log. So the events domain declares the service
 * interface, and this module provides it.
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
