/**
 * Tests how the declared fields of an observation become stored rows
 * (`encodeObservedFields`), and the reads and writes of the field table on a migrated database.
 */
import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import type {
  EntityObservation,
  QualifiedEntityFieldDeclaration,
  QualifiedEntityKindDeclaration,
} from "@hercule/plugin-host";
import { inTransaction, TestDatabase } from "../db/testing";
import {
  deleteOrphanedFields,
  encodeObservedFields,
  readStoredFieldRows,
  readTitledFieldRows,
  writeFieldRows,
  type EncodedField,
  type StoredFieldRow,
} from "./entity-fields";

const PROJECT_KIND: QualifiedEntityKindDeclaration = {
  word: "acme/project",
  noun: "Project",
  refPrefix: "acme:project:",
  pace: "context",
  patience: 0,
  identifier: "{key}",
  person: null,
  owner: null,
  status: null,
  facts: [],
  reasons: {},
};

const FIELDS: ReadonlyArray<QualifiedEntityFieldDeclaration> = [
  { key: "title", label: "Title", type: "text" },
  { key: "owner", label: "Owner", type: "person" },
  { key: "level", label: "Level", type: "enum", values: [{ value: "high" }, { value: "low" }] },
  { key: "size", label: "Size", type: "number" },
  { key: "cost", label: "Cost", type: "money", currency: "EUR" },
  { key: "since", label: "Since", type: "age" },
  { key: "urgent", label: "Urgent", type: "bool" },
  {
    key: "project",
    label: "Project",
    type: "text",
    facet: { plural: "Projects", values: "acme/project" },
  },
];

const TICKET_KIND: QualifiedEntityKindDeclaration = {
  ...PROJECT_KIND,
  word: "acme/ticket",
  refPrefix: "acme:ticket:",
  pace: "fast",
  fields: FIELDS,
};

const observe = (fields: Record<string, string | number | boolean | null>): EntityObservation => ({
  kind: "ticket",
  ref: "acme:ticket:1",
  title: "One",
  fields,
  concerns: [],
  sourceUpdatedAt: "2026-03-01T10:00:00.000Z",
});

const encode = (fields: Record<string, string | number | boolean | null>) =>
  encodeObservedFields({
    declaration: TICKET_KIND,
    kinds: [TICKET_KIND, PROJECT_KIND],
    observation: observe(fields),
  });

const row = (key: string, text: string | null, number: number | null): EncodedField => ({
  key,
  text_value: text,
  number_value: number,
});

describe("encoding the declared fields of an observation", () => {
  it("stores text, person and enum as text, and the rest as numbers", () => {
    expect(
      encode({
        title: "Fix it",
        owner: "marta",
        level: "high",
        size: 3,
        cost: 12.5,
        since: "2026-03-01T10:00:00Z",
        urgent: true,
        project: "acme:project:harbour",
      }),
    ).toEqual({
      rows: [
        row("title", "Fix it", null),
        row("owner", "marta", null),
        row("level", "high", null),
        row("size", null, 3),
        row("cost", null, 12.5),
        row("since", null, Date.parse("2026-03-01T10:00:00Z")),
        row("urgent", null, 1),
        row("project", "acme:project:harbour", null),
      ],
    });
    expect(encode({ urgent: false })).toEqual({ rows: [row("urgent", null, 0)] });
  });

  it("accepts ages at the ends of the years 0000 to 9999, with an offset, and on a leap day", () => {
    const since = (value: string) => encode({ since: value });
    expect(since("0000-01-01T00:00:00Z")).toEqual({
      rows: [row("since", null, Date.parse("0000-01-01T00:00:00Z"))],
    });
    expect(since("9999-12-31T23:59:59.999Z")).toEqual({
      rows: [row("since", null, Date.parse("9999-12-31T23:59:59.999Z"))],
    });
    expect(since("2026-03-01T10:00:00+02:00")).toEqual({
      rows: [row("since", null, Date.parse("2026-03-01T08:00:00Z"))],
    });
    expect(since("2028-02-29T10:00Z")).toHaveProperty("rows");
    expect(since("2027-02-29T10:00Z")).toHaveProperty("refusal");
  });

  it("gives a null or missing field no row, and ignores an undeclared one", () => {
    expect(encode({ title: null, size: 2, unknown: "x" })).toEqual({
      rows: [row("size", null, 2)],
    });
  });

  it.each([
    { name: "a number for a text field", fields: { title: 3 }, expected: "must be a string" },
    {
      name: "a string for a number field",
      fields: { size: "3" },
      expected: "must be a finite number",
    },
    { name: "a string for a bool field", fields: { urgent: "yes" }, expected: "must be a boolean" },
    {
      name: "a bool for a money field",
      fields: { cost: true },
      expected: "must be a finite number",
    },
    {
      name: "an enum value the kind does not declare",
      fields: { level: "medium" },
      expected: 'one of "high", "low"',
    },
    ...[
      "last week",
      "1",
      "March 3, 2026",
      "2026-03-01",
      "2026-03-01T10:00",
      "2026-02-31T10:00:00Z",
      "2026-03-01T24:00:00Z",
      "+100000-01-01T00:00:00Z",
      "0000-01-01T00:00:00+01:00",
      "9999-12-31T23:00:00-05:00",
    ].map((since) => ({
      name: `the age ${since}`,
      fields: { since },
      expected: "an ISO 8601 timestamp",
    })),
    {
      name: "a context field that is not a ref of that kind",
      fields: { project: "Harbour" },
      expected: 'a ref that starts with "acme:project:"',
    },
  ])("refuses $name, naming the ref, the field and what was expected", ({ fields, expected }) => {
    const [key] = Object.keys(fields);
    const result = encode(fields);
    expect(result).toHaveProperty("refusal");
    const { refusal } = result as { readonly refusal: string };
    expect(refusal).toContain("acme:ticket:1");
    expect(refusal).toContain(`"${key}"`);
    expect(refusal).toContain(expected);
  });

  it("encodes nothing for a partial observation", () => {
    const partial: EntityObservation = {
      kind: "ticket",
      ref: "acme:ticket:1",
      title: "One",
      partial: true,
    };
    expect(
      encodeObservedFields({
        declaration: TICKET_KIND,
        kinds: [TICKET_KIND],
        observation: partial,
      }),
    ).toEqual({ rows: [] });
  });
});

const stored = (ref: string, key: string, text: string | null, number: number | null) =>
  ({ ref, key, text_value: text, number_value: number }) satisfies StoredFieldRow;

const run = <A>(
  body: (sql: SqlClient.SqlClient) => Effect.Effect<A, unknown, SqlClient.SqlClient>,
) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      return yield* body(sql);
    }).pipe(inTransaction, Effect.provide(TestDatabase), Effect.orDie),
  );

describe("the field table", () => {
  it("writes the difference and reads the rows of many refs ordered by ref then key", async () => {
    const result = await run(() =>
      Effect.gen(function* () {
        const first = yield* writeFieldRows(
          [
            { ref: "b", fields: [row("z", "1", null), row("a", null, 2)] },
            { ref: "a", fields: [row("k", "x", null)] },
          ],
          [],
        );
        const afterFirst = yield* readStoredFieldRows(["b", "a", "c"]);
        const second = yield* writeFieldRows(
          [{ ref: "b", fields: [row("a", null, 5)] }],
          afterFirst,
        );
        const quiet = yield* writeFieldRows(
          [{ ref: "a", fields: [row("k", "x", null)] }],
          afterFirst,
        );
        return {
          first,
          afterFirst,
          second,
          quiet,
          afterSecond: yield* readStoredFieldRows(["a", "b"]),
        };
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
    expect(result.afterSecond).toEqual([stored("a", "k", "x", null), stored("b", "a", null, 5)]);
  });

  it("round-trips a value that looks like JSON or a number, and an empty ref list", async () => {
    const rows = await run(() =>
      Effect.gen(function* () {
        yield* writeFieldRows(
          [
            {
              ref: "a",
              fields: [row("t", '{"a":1}', null), row("n", "42", null), row("m", null, 0.1)],
            },
          ],
          [],
        );
        return { rows: yield* readStoredFieldRows(["a"]), none: yield* readStoredFieldRows([]) };
      }),
    );
    expect(rows.rows).toEqual([
      stored("a", "m", null, 0.1),
      stored("a", "n", "42", null),
      stored("a", "t", '{"a":1}', null),
    ]);
    expect(rows.none).toEqual([]);
  });

  it("deletes the rows of refs that have no entity", async () => {
    const result = await run((sql) =>
      Effect.gen(function* () {
        yield* writeFieldRows([{ ref: "a", fields: [row("k", "x", null)] }], []);
        const at = "2026-03-01T00:00:00.000Z";
        yield* sql`INSERT INTO external_entities (id, ref, kind, noun, completeness, title,
            source_updated_at, first_observed_at, updated_at)
          VALUES (x'00000000000000000000000000000001', 'b', 'k', 'N', 'full', 'T', ${at}, ${at}, ${at})`;
        yield* writeFieldRows([{ ref: "b", fields: [row("k", "y", null)] }], []);
        yield* deleteOrphanedFields();
        return yield* readStoredFieldRows(["a", "b"]);
      }),
    );
    expect(result).toEqual([stored("b", "k", "y", null)]);
  });

  it("reads the title of the record a text value points at only while some Connection reads it", async () => {
    const result = await run((sql) =>
      Effect.gen(function* () {
        const at = "2026-03-01T00:00:00.000Z";
        yield* sql`INSERT INTO connections (id, plugin_id, type, label, display_name, account_id,
            status, labels, config, created_at, updated_at)
          VALUES (x'0000000000000000000000000000000c', 'acme', 'acme/account', 'a', 'a', 'a',
            'connected', '[]', '{}', ${at}, ${at})`;
        const entity = (id: number, ref: string, title: string) => sql`
          INSERT INTO external_entities (id, ref, kind, noun, completeness, title,
              source_updated_at, first_observed_at, updated_at)
          VALUES (${new Uint8Array(16).fill(id)}, ${ref}, 'k', 'N', 'full', ${title}, ${at}, ${at}, ${at})`;
        yield* entity(1, "acme:project:open", "Open");
        yield* entity(2, "acme:project:hidden", "Hidden");
        const observe = (ref: string, access: string) => sql`
          INSERT INTO external_entity_observations (ref, connection_id, access)
          VALUES (${ref}, x'0000000000000000000000000000000c', ${access})`;
        yield* observe("acme:project:open", "ok");
        yield* observe("acme:project:hidden", "inaccessible");
        yield* writeFieldRows(
          [
            {
              ref: "a",
              fields: [
                row("open", "acme:project:open", null),
                row("hidden", "acme:project:hidden", null),
                row("missing", "acme:project:none", null),
                row("size", null, 2),
              ],
            },
          ],
          [],
        );
        return yield* readTitledFieldRows(["a"]);
      }),
    );
    expect(result.map(({ key, title }) => [key, title])).toEqual([
      ["hidden", null],
      ["missing", null],
      ["open", "Open"],
      ["size", null],
    ]);
  });
});
