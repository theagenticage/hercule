/**
 * The Ingest Reconciler: the loop that keeps one ingest handle open for every
 * Connection that should be ingesting, and none for the rest.
 *
 * A Connection should be ingesting when an active plugin has an event source
 * for its type and its status is `connected` or `error`. Every interval the
 * loop compares that set with the handles that are open:
 *
 * - it opens a handle for each Connection that should ingest and has none;
 * - it closes the handle of each Connection that should no longer ingest,
 *   because it was deleted, disabled, or needs reauthorization, or because
 *   its plugin stopped;
 * - it closes and reopens the handle of a Connection whose config or feed
 *   intervals changed, because a handle reads both only when it opens.
 *
 * Comparing on a timer, rather than reacting to each change, means no change
 * can be missed: a handle that is wrong now is put right at the next pass.
 */
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import { connectionRepository, type StoredConnection } from "../../connections";
import {
  computeIngestFingerprint,
  IngestLoops,
  PluginHost,
  type RegisteredEventSource,
} from "../../plugins";
import { absorbFailures } from "../absorbing";

/**
 * How often the Ingest Reconciler compares the open handles with the
 * Connections that should be ingesting, which is how long a change to a
 * Connection or a plugin can take to open or close a handle. Tests override
 * it.
 */
export const IngestReconcileInterval = Context.Reference<Duration.Duration>(
  "hercule/controller/daemon/IngestReconcileInterval",
  { defaultValue: (): Duration.Duration => Duration.seconds(2) },
);

/** A Connection that should be ingesting, and the event source to open it through. */
interface ConnectionToIngest {
  readonly source: RegisteredEventSource;
  readonly connection: StoredConnection;
}

/**
 * Opens and closes ingest handles until every Connection that should be
 * ingesting has one and no other Connection does, and repeats that every
 * interval. Never returns. A pass that fails is logged, and the next one runs.
 */
export const runIngestReconciler: Effect.Effect<
  never,
  never,
  PluginHost | IngestLoops | SqlClient.SqlClient
> = Effect.gen(function* () {
  const host = yield* PluginHost;
  const ingest = yield* IngestLoops;
  const connections = yield* connectionRepository;
  const interval = yield* IngestReconcileInterval;

  /**
   * Returns each Connection that should be ingesting, keyed by its id, with
   * the source to open it through. Registration allows one source per
   * Connection type, so each Connection has at most one.
   */
  const listConnectionsToIngest: Effect.Effect<
    ReadonlyMap<string, ConnectionToIngest>,
    SqlError
  > = Effect.gen(function* () {
    const sources = yield* host.listActiveEventSources();
    const candidates = yield* connections.listByStatus(["connected", "error"]);
    const wanted = new Map<string, ConnectionToIngest>();
    for (const connection of candidates) {
      const source = sources.find((one) => one.connectionType === connection.type);
      if (source !== undefined) wanted.set(connection.id, { source, connection });
    }
    return wanted;
  });

  /** Closes the handles that should not be open as they are, then opens the missing ones. */
  const reconcileHandles: Effect.Effect<void, SqlError> = Effect.gen(function* () {
    const wanted = yield* listConnectionsToIngest;
    const open = new Set<string>();
    for (const handle of yield* ingest.listOpen()) {
      const match = wanted.get(handle.connectionId);
      if (
        match !== undefined &&
        handle.fingerprint === computeIngestFingerprint(match.connection)
      ) {
        open.add(handle.connectionId);
      } else {
        yield* ingest.close(handle.connectionId);
      }
    }
    for (const [id, { source, connection }] of wanted) {
      if (!open.has(id)) yield* ingest.open(source, connection);
    }
  });

  while (true) {
    // Under the plugin host's gate, so a plugin cannot be stopped between
    // the read of its active sources and the open of a handle through one.
    // Closing waits for the plugin's `close`, but no poll runs under the gate.
    yield* absorbFailures("Reconciling ingest handles failed", host.serialized(reconcileHandles));
    yield* Effect.sleep(interval);
  }
});
