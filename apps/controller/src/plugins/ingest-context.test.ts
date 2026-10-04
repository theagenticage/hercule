/**
 * Tests the `IngestContext` an event source's handle receives: what `emit`
 * accepts and writes to the event log, and what `resources` lists. The
 * database and the host are real; the source is the fixture from `./testing`.
 */
import { describe, expect, it } from "vitest";
import { Cause, Effect, Exit } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import {
  MAX_EMITTED_FIELD_BYTES,
  type EmittedEvent,
  type IngestContext,
  type PluginCapability,
} from "@hercule/plugin-host";
import { connectionRepository, ConnectionNotIngesting } from "../connections";
import { nowIso, uuidToString } from "../db";
import { resourceRepository } from "../resources";
import { PluginHost } from "./index";
import { ingestContexts } from "./ingest-context";
import {
  asUser,
  buildPluginStack,
  createEventSourceFixture,
  EVENT_SOURCE_FIXTURE,
  insertFixtureConnection,
} from "./testing";

/**
 * Boots the fixture's plugin, inserts one Connection of its type, and runs the
 * test body with the context built for that Connection.
 */
const runWithContext = <A, E>(
  body: (
    context: IngestContext,
    connectionId: string,
  ) => Effect.Effect<A, E, SqlClient.SqlClient | PluginHost>,
  capabilities?: ReadonlyArray<PluginCapability>,
): Promise<A> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const host = yield* PluginHost;
      yield* host.boot([
        createEventSourceFixture(capabilities === undefined ? {} : { capabilities }).plugin,
      ]);
      const connection = yield* insertFixtureConnection();
      const source = (yield* host.listActiveEventSources())[0];
      if (source === undefined) return yield* Effect.die("the fixture registered no source");
      const contexts = yield* ingestContexts;
      return yield* body(
        contexts.buildIngestContext(source, { id: connection.id, config: {} }),
        connection.id,
      );
    }).pipe(Effect.provide(buildPluginStack()), asUser),
  );

const THING_DONE: EmittedEvent = {
  kind: EVENT_SOURCE_FIXTURE.kind,
  dedupKey: "thing-1",
  occurredAt: "2026-09-01T10:00:00Z",
  payload: { title: "Shipped" },
  refs: ["acme:thing:1"],
};

interface EventRow {
  readonly source: string;
  readonly connection_id: Uint8Array | null;
  readonly system: string;
  readonly kind: string;
  readonly occurred_at: string;
  readonly dedup_key: string;
  readonly refs: string;
  readonly url: string | null;
  readonly payload: string;
  readonly raw: string | null;
  readonly actor: string | null;
}

/** Reads every event of the fixture's kind, oldest first. */
const readFixtureEvents = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql<EventRow>`
    SELECT source, connection_id, system, kind, occurred_at, dedup_key, refs, url, payload, raw,
           actor
    FROM events WHERE kind = ${EVENT_SOURCE_FIXTURE.kind} ORDER BY id
  `;
});

/** Runs an emit and returns its error message, or fails the test when it succeeds. */
const readEmitFailure = (context: IngestContext, event: EmittedEvent) =>
  Effect.map(Effect.flip(context.emit(event)), (error) => error.message);

describe("IngestContext.emit", () => {
  it("writes the event stamped with the plugin as source and the Connection", async () => {
    const { rows, connectionId } = await runWithContext((context, connectionId) =>
      Effect.gen(function* () {
        yield* context.emit({
          ...THING_DONE,
          url: "https://acme.example/things/1",
          raw: { id: 1, state: "done" },
        });
        return { rows: yield* readFixtureEvents, connectionId };
      }),
    );

    expect(rows).toHaveLength(1);
    const row = rows[0];
    if (row === undefined) throw new Error("the event was not written");
    expect(row.connection_id === null ? null : uuidToString(row.connection_id)).toBe(connectionId);
    expect(row).toMatchObject({
      source: EVENT_SOURCE_FIXTURE.pluginId,
      system: EVENT_SOURCE_FIXTURE.pluginId,
      kind: EVENT_SOURCE_FIXTURE.kind,
      occurred_at: "2026-09-01T10:00:00.000Z",
      dedup_key: "thing-1",
      url: "https://acme.example/things/1",
      actor: null,
    });
    expect(JSON.parse(row.refs)).toEqual(["acme:thing:1"]);
    expect(JSON.parse(row.payload)).toEqual({ title: "Shipped" });
    expect(row.raw === null ? null : JSON.parse(row.raw)).toEqual({ id: 1, state: "done" });
  });

  it("keeps the system the source names, and converts a time zone offset to UTC", async () => {
    const rows = await runWithContext((context) =>
      Effect.andThen(
        context.emit({
          ...THING_DONE,
          system: "acme-cloud",
          occurredAt: "2026-09-01T12:00:00+02:00",
        }),
        readFixtureEvents,
      ),
    );

    expect(rows[0]).toMatchObject({
      system: "acme-cloud",
      occurred_at: "2026-09-01T10:00:00.000Z",
    });
  });

  it("writes an event once when its dedup key is emitted twice", async () => {
    const rows = await runWithContext((context) =>
      Effect.gen(function* () {
        yield* context.emit(THING_DONE);
        yield* context.emit({ ...THING_DONE, payload: { title: "Shipped again" } });
        return yield* readFixtureEvents;
      }),
    );

    expect(rows.map((row): unknown => JSON.parse(row.payload))).toEqual([{ title: "Shipped" }]);
  });

  it("refuses a kind the source did not declare, naming it", async () => {
    const message = await runWithContext((context) =>
      readEmitFailure(context, { ...THING_DONE, kind: "acme.thing.undone" }),
    );

    expect(message).toContain("acme.thing.undone");
  });

  it.each([
    ["a missing field", {}],
    ["a field the schema does not name", { title: "Shipped", extra: true }],
  ])("refuses a payload with %s", async (_, payload) => {
    const message = await runWithContext((context) =>
      readEmitFailure(context, { ...THING_DONE, payload }),
    );

    expect(message).toContain("does not match the kind's schema");
  });

  it.each([
    ["an empty dedup key", { dedupKey: "" }, "dedupKey"],
    ["a malformed ref", { refs: ["not a ref"] }, "refs"],
    ["a time without a time zone", { occurredAt: "2026-09-01T10:00:00" }, "occurredAt"],
    ["a time that is not a time", { occurredAt: "yesterday" }, "occurredAt"],
  ] as const)("refuses an event with %s", async (_, change, field) => {
    const message = await runWithContext((context) =>
      readEmitFailure(context, { ...THING_DONE, ...change }),
    );

    expect(message).toContain(field);
  });

  it.each([
    ["a payload", { payload: { title: "x".repeat(MAX_EMITTED_FIELD_BYTES) } }, "payload"],
    ["a raw body", { raw: { body: "x".repeat(MAX_EMITTED_FIELD_BYTES) } }, "raw"],
  ] as const)("refuses %s larger than its limit, and writes nothing", async (_, change, field) => {
    const { message, rows } = await runWithContext((context) =>
      Effect.gen(function* () {
        return {
          message: yield* readEmitFailure(context, { ...THING_DONE, ...change }),
          rows: yield* readFixtureEvents,
        };
      }),
    );

    expect(message).toContain(`the ${field} of a ${EVENT_SOURCE_FIXTURE.kind} event is`);
    expect(rows).toEqual([]);
  });

  it.each([
    [
      "disabled",
      (id: string) =>
        Effect.flatMap(connectionRepository, (connections) =>
          Effect.flatMap(nowIso, (at) => connections.update(id, { status: "disabled" }, at)),
        ),
    ],
    [
      "deleted",
      (id: string) => Effect.flatMap(connectionRepository, (connections) => connections.delete(id)),
    ],
  ] as const)("dies and writes nothing once the Connection is %s", async (_, change) => {
    const { exit, rows } = await runWithContext((context, connectionId) =>
      Effect.gen(function* () {
        yield* change(connectionId);
        return {
          exit: yield* Effect.exit(context.emit(THING_DONE)),
          rows: yield* readFixtureEvents,
        };
      }),
    );

    expect(Exit.isFailure(exit) && Cause.squash(exit.cause)).toBeInstanceOf(ConnectionNotIngesting);
    expect(rows).toEqual([]);
  });
});

describe("IngestContext.resources", () => {
  it("lists the Resources linked to the Connection, a repo with its canonical remote", async () => {
    const linked = await runWithContext(
      (context, connectionId) =>
        Effect.gen(function* () {
          const resources = yield* resourceRepository;
          const at = "2026-09-01T10:00:00.000Z";
          const fields = { setupCommand: null, workspaceInclude: false, at };
          const repo = yield* resources.insert({
            ...fields,
            kind: "repo",
            remote: "git@acme.example:owner/repo.git",
            canonicalRemote: "acme.example/owner/repo",
            label: null,
            connectionId,
          });
          const folder = yield* resources.insert({
            ...fields,
            kind: "folder",
            remote: null,
            canonicalRemote: null,
            label: "Design",
            connectionId,
          });
          yield* resources.insert({
            ...fields,
            kind: "folder",
            remote: null,
            canonicalRemote: null,
            label: "Unlinked",
            connectionId: null,
          });
          return {
            listed: yield* context.resources!.list(),
            ids: [repo.id, folder.id],
          };
        }),
      ["connections", "event-sources", "events", "resources"],
    );

    expect(linked.listed).toEqual([
      { id: linked.ids[0], kind: "repo", label: null, remote: "acme.example/owner/repo" },
      { id: linked.ids[1], kind: "folder", label: "Design", remote: null },
    ]);
  });

  it("is absent when the manifest did not request the resources capability", async () => {
    const resources = await runWithContext((context) => Effect.succeed(context.resources));

    expect(resources).toBeUndefined();
  });
});
