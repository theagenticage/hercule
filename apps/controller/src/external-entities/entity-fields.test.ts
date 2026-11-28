/**
 * Tests the field table on a migrated database: replacing the rows of many
 * refs, reading their values and card faces back, and the prune sweep.
 */
import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import { inTransaction, TestDatabase } from "../db/testing";
import type { ActiveEntityKind } from "./entity-records";
import { deleteOrphanedFields, readFieldValues, replaceFieldRows } from "./entity-fields";
import type { EncodedField } from "./field-values";

const row = (key: string, text: string | null, number: number | null): EncodedField => ({
  key,
  text_value: text,
  number_value: number,
});

const stored = (ref: string, key: string, text: string | null, number: number | null) => ({
  ref,
  key,
  text_value: text,
  number_value: number,
});

const AT = "2026-03-01T00:00:00.000Z";

const run = <A>(
  body: (sql: SqlClient.SqlClient) => Effect.Effect<A, unknown, SqlClient.SqlClient>,
) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      return yield* body(sql);
    }).pipe(inTransaction, Effect.provide(TestDatabase), Effect.orDie),
  );

const readRows = (sql: SqlClient.SqlClient) =>
  sql<{
    readonly ref: string;
    readonly key: string;
    readonly text_value: string | null;
    readonly number_value: number | null;
  }>`SELECT ref, key, text_value, number_value FROM external_entity_fields ORDER BY ref, key`;

const insertEntity = (
  sql: SqlClient.SqlClient,
  id: number,
  ref: string,
  kind: string,
  title: string,
) => sql`
  INSERT INTO external_entities (id, ref, kind, noun, completeness, title,
      source_updated_at, first_observed_at, updated_at)
  VALUES (${new Uint8Array(16).fill(id)}, ${ref}, ${kind}, 'N', 'full', ${title}, ${AT}, ${AT}, ${AT})`;

describe("replacing field rows", () => {
  it("writes the difference and returns the refs that changed, sorted", async () => {
    const result = await run((sql) =>
      Effect.gen(function* () {
        const first = yield* replaceFieldRows([
          { ref: "b", fields: [row("z", "1", null), row("a", null, 2)] },
          { ref: "a", fields: [row("k", "x", null)] },
        ]);
        const afterFirst = yield* readRows(sql);
        const second = yield* replaceFieldRows([{ ref: "b", fields: [row("a", null, 5)] }]);
        const quiet = yield* replaceFieldRows([{ ref: "a", fields: [row("k", "x", null)] }]);
        const none = yield* replaceFieldRows([]);
        return { first, afterFirst, second, quiet, none, afterSecond: yield* readRows(sql) };
      }),
    );
    expect(result.first).toEqual(["a", "b"]);
    expect(result.afterFirst).toEqual([
      stored("a", "k", "x", null),
      stored("b", "a", null, 2),
      stored("b", "z", "1", null),
    ]);
    expect(result.second).toEqual(["b"]);
    expect(result.quiet).toEqual([]);
    expect(result.none).toEqual([]);
    expect(result.afterSecond).toEqual([stored("a", "k", "x", null), stored("b", "a", null, 5)]);
  });

  it("stores a value that looks like JSON or a number as it is", async () => {
    const rows = await run((sql) =>
      Effect.gen(function* () {
        yield* replaceFieldRows([
          {
            ref: "a",
            fields: [row("t", '{"a":1}', null), row("n", "42", null), row("m", null, 0.1)],
          },
        ]);
        return yield* readRows(sql);
      }),
    );
    expect(rows).toEqual([
      stored("a", "m", null, 0.1),
      stored("a", "n", "42", null),
      stored("a", "t", '{"a":1}', null),
    ]);
  });

  it("deletes the rows of refs that have no entity", async () => {
    const result = await run((sql) =>
      Effect.gen(function* () {
        yield* replaceFieldRows([{ ref: "a", fields: [row("k", "x", null)] }]);
        yield* insertEntity(sql, 1, "b", "k", "T");
        yield* replaceFieldRows([{ ref: "b", fields: [row("k", "y", null)] }]);
        yield* deleteOrphanedFields();
        return yield* readRows(sql);
      }),
    );
    expect(result).toEqual([stored("b", "k", "y", null)]);
  });
});

const TICKET: ActiveEntityKind = {
  kind: "acme/ticket",
  noun: "Ticket",
  refPrefix: "acme:ticket:",
  fields: [
    {
      key: "project",
      label: "Project",
      type: "text",
      facet: { plural: "Projects", values: "acme/project" },
    },
    { key: "size", label: "Size", type: "number" },
  ],
  face: { place: "project", fact: "size" },
};

const BUG: ActiveEntityKind = {
  kind: "acme/bug",
  noun: "Bug",
  refPrefix: "acme:bug:",
  fields: [{ key: "size", label: "Size", type: "number" }],
};

describe("reading field values", () => {
  it("reads many refs at once, each with the kind its entity was stored with", async () => {
    const result = await run((sql) =>
      Effect.gen(function* () {
        yield* insertEntity(sql, 1, "acme:ticket:1", "acme/ticket", "One");
        yield* insertEntity(sql, 2, "acme:bug:1", "acme/bug", "Bug");
        yield* insertEntity(sql, 3, "acme:ticket:2", "acme/ticket", "Two");
        yield* insertEntity(sql, 4, "acme:ticket:3", "acme/ticket", "Three");
        yield* insertEntity(sql, 5, "gone:1", "gone/kind", "Gone");
        yield* replaceFieldRows([
          { ref: "acme:ticket:1", fields: [row("size", null, 1)] },
          { ref: "acme:bug:1", fields: [row("size", null, 2)] },
          { ref: "acme:ticket:2", fields: [row("size", null, 3)] },
          { ref: "gone:1", fields: [row("size", null, 4)] },
        ]);
        return yield* readFieldValues(
          ["acme:ticket:2", "acme:bug:1", "acme:ticket:1", "acme:ticket:3", "gone:1", "missing"],
          [TICKET, BUG],
        );
      }),
    );
    const size = (number: number) => ({
      key: "size",
      label: "Size",
      type: "number",
      number,
    });
    expect([...result.keys()].sort()).toEqual([
      "acme:bug:1",
      "acme:ticket:1",
      "acme:ticket:2",
      "acme:ticket:3",
      "gone:1",
    ]);
    expect(result.get("acme:ticket:1")).toEqual({ fields: [size(1)], face: { fact: size(1) } });
    expect(result.get("acme:ticket:2")).toEqual({ fields: [size(3)], face: { fact: size(3) } });
    expect(result.get("acme:bug:1")).toEqual({ fields: [size(2)], face: null });
    expect(result.get("acme:ticket:3")).toEqual({ fields: [], face: {} });
    expect(result.get("gone:1")).toEqual({ fields: [], face: null });
  });

  it("reads no kinds as no fields, and no refs as an empty map", async () => {
    const result = await run((sql) =>
      Effect.gen(function* () {
        yield* insertEntity(sql, 1, "acme:ticket:1", "acme/ticket", "One");
        yield* replaceFieldRows([{ ref: "acme:ticket:1", fields: [row("size", null, 1)] }]);
        return {
          unknown: yield* readFieldValues(["acme:ticket:1"], undefined),
          empty: yield* readFieldValues([], [TICKET]),
        };
      }),
    );
    expect(result.unknown.get("acme:ticket:1")).toEqual({ fields: [], face: null });
    expect(result.empty.size).toBe(0);
  });

  it("shows the title of a referenced record only while some Connection reads it", async () => {
    const result = await run((sql) =>
      Effect.gen(function* () {
        yield* sql`INSERT INTO connections (id, plugin_id, type, label, display_name, account_id,
            status, labels, config, created_at, updated_at)
          VALUES (x'0000000000000000000000000000000c', 'acme', 'acme/account', 'a', 'a', 'a',
            'connected', '[]', '{}', ${AT}, ${AT})`;
        yield* insertEntity(sql, 1, "acme:project:open", "acme/project", "Open");
        yield* insertEntity(sql, 2, "acme:project:hidden", "acme/project", "Hidden");
        yield* insertEntity(sql, 3, "acme:ticket:1", "acme/ticket", "One");
        yield* insertEntity(sql, 4, "acme:ticket:2", "acme/ticket", "Two");
        yield* insertEntity(sql, 5, "acme:ticket:3", "acme/ticket", "Three");
        const observe = (ref: string, access: string) => sql`
          INSERT INTO external_entity_observations (ref, connection_id, access)
          VALUES (${ref}, x'0000000000000000000000000000000c', ${access})`;
        yield* observe("acme:project:open", "ok");
        yield* observe("acme:project:hidden", "inaccessible");
        yield* replaceFieldRows([
          { ref: "acme:ticket:1", fields: [row("project", "acme:project:open", null)] },
          { ref: "acme:ticket:2", fields: [row("project", "acme:project:hidden", null)] },
          { ref: "acme:ticket:3", fields: [row("project", "acme:project:none", null)] },
        ]);
        return yield* readFieldValues(
          ["acme:ticket:1", "acme:ticket:2", "acme:ticket:3"],
          [TICKET],
        );
      }),
    );
    expect(result.get("acme:ticket:1")?.fields).toEqual([
      {
        key: "project",
        label: "Project",
        type: "text",
        text: "Open",
        ref: "acme:project:open",
      },
    ]);
    expect(result.get("acme:ticket:2")?.fields).toEqual([]);
    expect(result.get("acme:ticket:3")?.fields).toEqual([]);
  });
});
