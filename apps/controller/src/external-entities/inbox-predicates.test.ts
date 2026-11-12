/**
 * Tests the compiler of Inbox clauses as text and parameters: what SQL a
 * clause becomes, that a value is always a bound parameter, and what is
 * refused. The queries those expressions answer are tested against a database
 * in `inbox-query.test.ts`.
 */
import { describe, expect, it } from "vitest";
import {
  compileInboxFilter,
  type CompiledSql,
  type DeclaredInboxField,
  type InboxFilterInput,
} from "./inbox-predicates";

const NOW = "2026-03-10T00:00:00.000Z";

const FIELDS: ReadonlyArray<DeclaredInboxField> = [
  {
    kind: "acme/ticket",
    key: "team",
    label: "Team",
    type: "text",
    isFacet: true,
    plural: "Teams",
    contextKind: "acme/team",
  },
  { kind: "acme/ticket", key: "size", label: "Size", type: "number", isFacet: false },
  { kind: "acme/bug", key: "size", label: "Size", type: "text", isFacet: false },
  { kind: "other/task", key: "team", label: "Team", type: "text", isFacet: false },
];

const compile = (input: Partial<InboxFilterInput>): CompiledSql => {
  const compiled = compileInboxFilter({
    clauses: [],
    text: "",
    now: NOW,
    fields: FIELDS,
    signalKinds: [],
    ...input,
  });
  if ("problem" in compiled) throw new Error(compiled.problem);
  return compiled;
};

const problem = (input: Partial<InboxFilterInput>): string => {
  const compiled = compileInboxFilter({
    clauses: [],
    text: "",
    now: NOW,
    fields: FIELDS,
    signalKinds: [],
    ...input,
  });
  if (!("problem" in compiled)) throw new Error("expected a problem");
  return compiled.problem;
};

describe("compileInboxFilter", () => {
  it("is true for no clause and no text", () => {
    expect(compile({})).toEqual({ sql: "1", params: [] });
  });

  it("compiles a boolean core key to a condition on the eligible row", () => {
    expect(compile({ clauses: [{ key: "asks", op: "is", value: true }] })).toEqual({
      sql: "e.ask_count IS NOT NULL",
      params: [],
    });
    expect(compile({ clauses: [{ key: "held", op: "is", value: false }] }).sql).toBe(
      "NOT (e.task_id IS NOT NULL)",
    );
  });

  it("binds every value instead of writing it into the text", () => {
    const hostile = "x'; DROP TABLE external_entities; --";
    const compiled = compile({
      clauses: [
        { key: "from", op: "is", value: hostile },
        { key: "team", op: "is", value: hostile },
      ],
      text: hostile,
    });
    expect(compiled.sql).not.toContain("DROP");
    expect(compiled.params).toContain(hostile);
    expect(compiled.sql.match(/\?/g)).toHaveLength(compiled.params.length);
  });

  it("measures a wait against the read clock", () => {
    const compiled = compile({ clauses: [{ key: "waiting", op: "over", value: 86_400 }] });
    expect(compiled.sql).toBe("e.oldest_ask IS NOT NULL AND e.oldest_ask < ?");
    expect(compiled.params).toEqual(["2026-03-09T00:00:00.000Z"]);
  });

  it("limits a declared field to the kinds that declare it, one alternative per way it is declared", () => {
    const compiled = compile({ clauses: [{ key: "size", op: "over", value: 3 }] });
    // `acme/ticket` declares a number, `acme/bug` a text: only the number can be over 3.
    expect(compiled.params).toEqual([JSON.stringify(["acme/ticket"]), "size", 3]);
    expect(compiled.sql).toContain("f.number_value > ?");
    expect(compiled.sql).not.toContain("text_value");
  });

  it("holds across sources unless the clause names one", () => {
    const across = compile({ clauses: [{ key: "team", op: "is", value: "Checkout" }] });
    expect(across.params.filter((param) => String(param).startsWith("["))).toHaveLength(2);
    const tied = compile({
      clauses: [{ key: "team", op: "is", value: "Checkout", source: "other" }],
    });
    expect(tied.params).toContain("other");
    expect(tied.params).toContain(JSON.stringify(["other/task"]));
  });

  it("matches a facet of records by ref or by a readable record's title", () => {
    const compiled = compile({
      clauses: [{ key: "team", op: "is", value: "Checkout", source: "acme" }],
    });
    expect(compiled.sql).toContain("t.title = ? COLLATE NOCASE");
    expect(compiled.sql).toContain("o.access = 'ok'");
  });

  it("matches nothing for an operator or value that does not fit the field's type", () => {
    expect(compile({ clauses: [{ key: "team", op: "over", value: 3, source: "other" }] }).sql).toBe(
      "0",
    );
    expect(compile({ clauses: [{ key: "size", op: "is", value: true, source: "acme" }] }).sql).toBe(
      "0",
    );
  });

  it("refuses a key nobody declares, and a core key used wrongly", () => {
    expect(problem({ clauses: [{ key: "colour", op: "is", value: "red" }] })).toContain(
      'no source declares a field "colour"',
    );
    expect(problem({ clauses: [{ key: "asks", op: "over", value: 1 }] })).toContain(
      'takes "is" with true or false',
    );
    expect(problem({ clauses: [{ key: "waiting", op: "is", value: 5 }] })).toContain("over");
  });

  it("escapes the patterns of free text and requires each word", () => {
    const compiled = compile({ text: "100% a_b" });
    expect(compiled.sql.match(/LIKE \?/g)).toHaveLength(8);
    expect(compiled.params).toContain("%100\\%%");
    expect(compiled.params).toContain("%a\\_b%");
  });

  it("refuses text of too many words", () => {
    expect(problem({ text: "a b c d e f g h i j k l m" })).toContain("13 words");
  });
});
