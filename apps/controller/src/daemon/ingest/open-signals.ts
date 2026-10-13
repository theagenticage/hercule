import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { OpenSignals } from "../../plugins";
import { signalRepository } from "../../signals";

const make = Effect.gen(function* () {
  const signals = yield* signalRepository;
  return OpenSignals.of({
    listForConnection: (connectionId) => Effect.orDie(signals.listOpenOnConnection(connectionId)),
  });
});

/**
 * Implements the plugins domain's `OpenSignals` port from the signal rows: an
 * event source reads through it which threads of its Connection still wait
 * on the user. The plugins domain cannot import the signals domain without
 * making the domain graph a cycle, so the controller daemon joins the two.
 */
export const OpenSignalsLayer: Layer.Layer<OpenSignals, never, SqlClient.SqlClient> =
  Layer.effect(OpenSignals)(make);
