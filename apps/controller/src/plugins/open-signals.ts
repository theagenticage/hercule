/**
 * The Open Signals port: how an event source's ingest reads the signals still
 * open on its Connection, through `IngestContext.openSignals`.
 *
 * Signals are their own domain, and that domain already depends on the
 * plugins domain (a signal's kind and actions come from a plugin). So the
 * plugins domain cannot import it. It declares this port instead, and the
 * controller daemon implements it from the signal rows (ADR 0033).
 */
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type { OpenSignal } from "@hercule/plugin-host";

/** The Open Signals port, which the controller daemon implements. */
export class OpenSignals extends Context.Service<
  OpenSignals,
  {
    /**
     * Returns the open signals raised from the events of the Connection
     * `connectionId`, oldest first. A database failure is a defect: the
     * plugin cannot recover from it.
     */
    readonly listForConnection: (connectionId: string) => Effect.Effect<ReadonlyArray<OpenSignal>>;
  }
>()("hercule/controller/plugins/OpenSignals") {}
