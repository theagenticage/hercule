import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { OpenSignals } from "../../plugins";
import { signalRepository } from "../../signals";

const make = Effect.gen(function* () {
  const signals = yield* signalRepository;
  return OpenSignals.of({
    listForConnection: (connectionId) =>
      Effect.orDie(
        Effect.map(signals.listOpenOnConnection(connectionId), (rows) =>
          rows.map((row) => ({
            kind: row.kind,
            threadRef: row.threadRef,
            raisedAt: row.createdAt,
          })),
        ),
      ),
  });
});

/**
 * Implements the plugins domain's Open Signals port from the signal rows.
 */
export const OpenSignalsLayer: Layer.Layer<OpenSignals, never, SqlClient.SqlClient> =
  Layer.effect(OpenSignals)(make);
