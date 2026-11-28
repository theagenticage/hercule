/**
 * Tests the meaning of the fields of an External Entity: how an observation's
 * declared fields become stored rows (`encodeObservedFields`), how a stored
 * row becomes a field value and the card face (`decodeEntityFields`), and that
 * every type survives the round trip between the two.
 */
import { describe, expect, it } from "vitest";
import type {
  QualifiedEntityFieldDeclaration,
  QualifiedEntityKindDeclaration,
} from "@hercule/plugin-host";
import type { ActiveEntityKind } from "./entity-records";
import {
  decodeEntityFields,
  encodeObservedFields,
  type EncodedField,
  type TitledField,
} from "./field-values";
import type { FullEntityObservation } from "./slots";

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

const observe = (
  fields: Record<string, string | number | boolean | null>,
): FullEntityObservation => ({
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
});

describe("the round trip of a field", () => {
  const readable = (project: string) => (project === "acme:project:harbour" ? "Harbour" : null);
  it.each([
    { key: "title", value: "Fix it", decoded: { type: "text", text: "Fix it" } },
    { key: "owner", value: "marta", decoded: { type: "person", text: "marta" } },
    { key: "level", value: "high", decoded: { type: "enum", value: "high", text: "high" } },
    { key: "size", value: 3, decoded: { type: "number", number: 3 } },
    { key: "cost", value: 12.5, decoded: { type: "money", amount: 12.5, currency: "EUR" } },
    {
      key: "since",
      value: "2026-03-01T10:00:00+02:00",
      decoded: { type: "age", since: "2026-03-01T08:00:00.000Z" },
    },
    { key: "urgent", value: true, decoded: { type: "bool", value: true } },
    { key: "urgent", value: false, decoded: { type: "bool", value: false } },
    {
      key: "project",
      value: "acme:project:harbour",
      decoded: { type: "text", text: "Harbour", ref: "acme:project:harbour" },
    },
  ])("gives back the $key value $value", ({ key, value, decoded }) => {
    const encoded = encode({ [key]: value });
    expect(encoded).toHaveProperty("rows");
    const [row] = (encoded as { readonly rows: ReadonlyArray<EncodedField> }).rows;
    const declaration = FIELDS.find((field) => field.key === key)!;
    const titled: TitledField = {
      ...row!,
      title: row!.text_value === null ? null : readable(row!.text_value),
    };
    const kind: ActiveEntityKind = {
      kind: "acme/ticket",
      noun: "Ticket",
      refPrefix: "acme:ticket:",
      fields: [declaration],
    };
    expect(decodeEntityFields(kind, [titled]).fields).toEqual([
      { key, label: declaration.label, ...decoded },
    ]);
  });
});

const TRACKER_PROJECT_REF = "tracker:project:p1";

const TRACKER_TICKET: ActiveEntityKind = {
  kind: "tracker/ticket",
  noun: "Ticket",
  refPrefix: "tracker:ticket:",
  fields: [
    {
      key: "project",
      label: "Project",
      type: "text",
      facet: { plural: "Projects", values: "tracker/project" },
    },
    { key: "assignee", label: "Assignee", type: "person" },
    {
      key: "priority",
      label: "Priority",
      type: "enum",
      values: [{ value: "p1", label: "Urgent" }, { value: "p2" }],
    },
    { key: "estimate", label: "Estimate", type: "number" },
    { key: "budget", label: "Budget", type: "money", currency: "EUR" },
    { key: "opened", label: "Opened", type: "age" },
    { key: "blocked", label: "Blocked", type: "bool" },
    { key: "note", label: "Note", type: "text" },
  ],
  face: { place: "project", context: "priority", fact: "budget" },
};

/** A text row; a row holding the project ref carries the title of its readable record. */
const text = (key: string, value: string): TitledField => ({
  key,
  text_value: value,
  number_value: null,
  title: value === TRACKER_PROJECT_REF ? "Apollo" : null,
});

const number = (key: string, value: number): TitledField => ({
  key,
  text_value: null,
  number_value: value,
  title: null,
});

describe("decodeEntityFields", () => {
  it("decodes each type and returns the values in declaration order", () => {
    const rows = [
      number("blocked", 1),
      text("note", "hello"),
      number("opened", Date.UTC(2026, 0, 2)),
      number("budget", 12.5),
      number("estimate", 3),
      text("priority", "p1"),
      text("assignee", "Ada"),
      text("project", TRACKER_PROJECT_REF),
    ];
    const { fields } = decodeEntityFields(TRACKER_TICKET, rows);
    expect(fields).toEqual([
      { key: "project", label: "Project", type: "text", text: "Apollo", ref: TRACKER_PROJECT_REF },
      { key: "assignee", label: "Assignee", type: "person", text: "Ada" },
      { key: "priority", label: "Priority", type: "enum", value: "p1", text: "Urgent" },
      { key: "estimate", label: "Estimate", type: "number", number: 3 },
      { key: "budget", label: "Budget", type: "money", amount: 12.5, currency: "EUR" },
      { key: "opened", label: "Opened", type: "age", since: "2026-01-02T00:00:00.000Z" },
      { key: "blocked", label: "Blocked", type: "bool", value: true },
      { key: "note", label: "Note", type: "text", text: "hello" },
    ]);
  });

  it("uses the value as the text of an enum value with no label, and reads bool 0 as false", () => {
    const { fields } = decodeEntityFields(TRACKER_TICKET, [
      text("priority", "p2"),
      number("blocked", 0),
    ]);
    expect(fields).toEqual([
      { key: "priority", label: "Priority", type: "enum", value: "p2", text: "p2" },
      { key: "blocked", label: "Blocked", type: "bool", value: false },
    ]);
  });

  it("fills the face slots and leaves out a slot whose field has no value", () => {
    const rows = [text("project", TRACKER_PROJECT_REF), number("budget", 5)];
    const { face } = decodeEntityFields(TRACKER_TICKET, rows);
    expect(face).toEqual({
      place: {
        key: "project",
        label: "Project",
        type: "text",
        text: "Apollo",
        ref: TRACKER_PROJECT_REF,
      },
      fact: { key: "budget", label: "Budget", type: "money", amount: 5, currency: "EUR" },
    });
  });

  it("ignores a row of an undeclared key", () => {
    const { fields } = decodeEntityFields(TRACKER_TICKET, [text("gone", "x")]);
    expect(fields).toEqual([]);
  });

  it("omits stale rows instead of failing on them", () => {
    const rows = [
      number("assignee", 4),
      text("estimate", "4"),
      text("priority", "p9"),
      text("project", "tracker:project:unknown"),
      number("blocked", 2),
      number("opened", 1e300),
      number("opened", Date.UTC(9999, 11, 31, 23, 59, 59, 999) + 1),
      { key: "note", text_value: "a", number_value: 1, title: null },
      { key: "budget", text_value: null, number_value: null, title: null },
    ];
    expect(decodeEntityFields(TRACKER_TICKET, rows)).toEqual({ fields: [], face: {} });
  });

  it("gives no fields and no face for a kind that is not active", () => {
    expect(decodeEntityFields(undefined, [text("note", "x")])).toEqual({
      fields: [],
      face: null,
    });
  });

  it("gives a null face for a kind that declares none", () => {
    const withoutFace: ActiveEntityKind = {
      kind: TRACKER_TICKET.kind,
      noun: TRACKER_TICKET.noun,
      refPrefix: TRACKER_TICKET.refPrefix,
      fields: TRACKER_TICKET.fields!,
    };
    const { face, fields } = decodeEntityFields(withoutFace, [text("note", "x")]);
    expect(face).toBeNull();
    expect(fields).toHaveLength(1);
  });
});

describe("a ref-valued field", () => {
  it("is left out, and so is the face slot that names it, when its record has no readable title", () => {
    const unreadable: TitledField = { ...text("project", TRACKER_PROJECT_REF), title: null };
    const { fields, face } = decodeEntityFields(TRACKER_TICKET, [unreadable]);
    expect(fields).toEqual([]);
    expect(face).toEqual({});
  });
});
