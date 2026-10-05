/**
 * Tests the Ingest Reconciler on a `TestClock`: which Connections it opens a
 * handle for, and how it closes or reopens a handle when a Connection or its
 * plugin changes. The plugin is the scripted event source fixture; the host,
 * the ingest loops and the database are real.
 */
import { describe, expect, it } from "vitest";
import { Duration, Effect } from "effect";
import { TestClock } from "effect/testing";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import type { ConnectionStatus } from "@hercule/contract";
import { AuthError } from "@hercule/plugin-host";
import { connectionRepository, type StoredConnection } from "../../connections";
import { nowIso } from "../../db";
import { IngestLoops, PluginHost } from "../../plugins";
import {
  asUser,
  buildPluginStack,
  createEventSourceFixture,
  insertFixtureConnection,
  type EventSourceFixture,
} from "../../plugins/testing";
import { runIngestReconciler } from "./reconciler";

type Services = PluginHost | IngestLoops | SqlClient.SqlClient;

/**
 * Boots the fixture's plugin and runs the test body with the Ingest
 * Reconciler running beside it, on a `TestClock`, at its default interval of
 * two seconds.
 */
const runWithReconciler = <A, E>(
  fixture: EventSourceFixture,
  body: Effect.Effect<A, E, Services>,
): Promise<A> =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        yield* Effect.flatMap(PluginHost, (host) => host.boot([fixture.plugin]));
        yield* Effect.forkScoped(runIngestReconciler);
        return yield* body;
      }),
    ).pipe(Effect.provide(buildPluginStack()), Effect.provide(TestClock.layer()), asUser),
  );

/** Moves the clock forward by whole seconds, running every timer that comes due. */
const advance = (seconds: number) => TestClock.adjust(Duration.seconds(seconds));

/** Inserts a Connection of the fixture's type with the label, then gives it the status. */
const insertConnectionWithStatus = (label: string, status: ConnectionStatus) =>
  Effect.gen(function* () {
    const connection = yield* insertFixtureConnection({ label });
    if (status !== "connected") yield* editConnection(connection.id, { status });
    return connection.id;
  });

/** Applies an edit to a Connection, as the connection service would. */
const editConnection = (
  id: string,
  edit: Partial<Pick<StoredConnection, "status" | "config" | "feedIntervals">>,
) =>
  Effect.flatMap(connectionRepository, (connections) =>
    Effect.flatMap(nowIso, (at) => connections.update(id, edit, at)),
  );

/** Lists the ids of the Connections whose handle is open, sorted. */
const listOpenIds = Effect.flatMap(IngestLoops, (ingest) =>
  Effect.map(ingest.listOpen(), (open) => open.map((one) => one.connectionId).sort()),
);

/** Counts the opens and closes the fixture's source has received. */
const countOpensAndCloses = (fixture: EventSourceFixture) => ({
  opens: fixture.calls.filter((call) => call === "open").length,
  closes: fixture.calls.filter((call) => call === "close").length,
});

describe("the Ingest Reconciler", () => {
  it("opens a handle for each connected or error Connection, and none for the rest", async () => {
    const fixture = createEventSourceFixture();
    const result = await runWithReconciler(
      fixture,
      Effect.gen(function* () {
        const connected = yield* insertConnectionWithStatus("connected", "connected");
        const failing = yield* insertConnectionWithStatus("failing", "error");
        yield* insertConnectionWithStatus("reauth", "needs-reauth");
        yield* insertConnectionWithStatus("off", "disabled");
        yield* advance(2);
        return { open: yield* listOpenIds, expected: [connected, failing].sort() };
      }),
    );

    expect(result.open).toEqual(result.expected);
    expect(fixture.opened.map((one) => one.connection.id).sort()).toEqual(result.expected);
  });

  it("leaves an unchanged handle alone from one pass to the next", async () => {
    const fixture = createEventSourceFixture();
    await runWithReconciler(
      fixture,
      Effect.gen(function* () {
        yield* insertFixtureConnection();
        yield* advance(2);
        yield* advance(30);
      }),
    );

    // The one close is the layer's teardown at the end of the test.
    expect(countOpensAndCloses(fixture)).toEqual({ opens: 1, closes: 1 });
  });

  it.each([
    ["disabled", { status: "disabled" }],
    ["needs reauthorization", { status: "needs-reauth" }],
  ] as const)("closes the handle of a Connection that is %s", async (_, edit) => {
    const fixture = createEventSourceFixture();
    const open = await runWithReconciler(
      fixture,
      Effect.gen(function* () {
        const connection = yield* insertFixtureConnection();
        yield* advance(2);
        yield* editConnection(connection.id, edit);
        yield* advance(2);
        return yield* listOpenIds;
      }),
    );

    expect(open).toEqual([]);
    expect(countOpensAndCloses(fixture)).toEqual({ opens: 1, closes: 1 });
  });

  it("closes the handle of a Connection that was deleted", async () => {
    const fixture = createEventSourceFixture();
    const open = await runWithReconciler(
      fixture,
      Effect.gen(function* () {
        const connection = yield* insertFixtureConnection();
        yield* advance(2);
        yield* Effect.flatMap(connectionRepository, (connections) =>
          connections.delete(connection.id),
        );
        yield* advance(2);
        return yield* listOpenIds;
      }),
    );

    expect(open).toEqual([]);
    expect(countOpensAndCloses(fixture)).toEqual({ opens: 1, closes: 1 });
  });

  it("opens no handle while the plugin is stopped, and opens one once it runs again", async () => {
    const fixture = createEventSourceFixture();
    const result = await runWithReconciler(
      fixture,
      Effect.gen(function* () {
        const host = yield* PluginHost;
        yield* insertFixtureConnection();
        yield* advance(2);
        yield* host.serialized(host.stop("acme"));
        yield* advance(2);
        const whileStopped = yield* listOpenIds;
        yield* host.serialized(host.refresh("acme"));
        yield* advance(2);
        return { whileStopped, afterRefresh: yield* listOpenIds };
      }),
    );

    expect(result.whileStopped).toEqual([]);
    expect(result.afterRefresh).toHaveLength(1);
    expect(countOpensAndCloses(fixture)).toEqual({ opens: 2, closes: 2 });
  });

  it.each([
    ["config", { config: { project: "rockets" } }],
    ["feed intervals", { feedIntervals: { notifications: 120 } }],
  ] as const)("closes and reopens the handle of a Connection whose %s changed", async (_, edit) => {
    const fixture = createEventSourceFixture();
    const result = await runWithReconciler(
      fixture,
      Effect.gen(function* () {
        const connection = yield* insertFixtureConnection();
        yield* advance(2);
        yield* editConnection(connection.id, edit);
        yield* advance(2);
        const calls = fixture.calls.filter((call) => call === "open" || call === "close");
        const open = yield* Effect.flatMap(IngestLoops, (ingest) => ingest.listOpen());
        return { calls, open, id: connection.id };
      }),
    );

    expect(result.calls).toEqual(["open", "close", "open"]);
    expect(result.open.map((one) => one.connectionId)).toEqual([result.id]);
    // The handle open now was opened with the edited Connection.
    expect(JSON.parse(result.open[0]!.fingerprint)).toMatchObject(edit);
  });

  it("reopens a Connection whose credentials were rejected, once it is reconnected", async () => {
    const fixture = createEventSourceFixture();
    fixture.poll = () => Effect.fail(new AuthError({ message: "Acme rejected the token" }));
    const result = await runWithReconciler(
      fixture,
      Effect.gen(function* () {
        const connection = yield* insertFixtureConnection();
        // The first poll is rejected, so the loop sets `needs-reauth` and ends.
        yield* advance(2);
        const afterRejection = yield* listOpenIds;
        fixture.poll = () => Effect.succeed({});
        yield* editConnection(connection.id, { status: "connected" });
        yield* advance(2);
        return { afterRejection, afterReconnect: yield* listOpenIds, id: connection.id };
      }),
    );

    expect(result.afterRejection).toEqual([]);
    expect(result.afterReconnect).toEqual([result.id]);
    expect(countOpensAndCloses(fixture).opens).toBe(2);
  });
});
