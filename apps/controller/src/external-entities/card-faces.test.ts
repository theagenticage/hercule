/**
 * Tests how the stored field rows of a thing become the field values and the
 * card face of its kind. The kind is an invented tracker with one field of
 * every type, and a project field whose values are the records of a context
 * kind.
 */
import { describe, expect, it } from "vitest";
import type { ActiveEntityKind } from "./entity-records";
import type { TitledFieldRow } from "./entity-fields";
import { drawFieldsAndCardFace } from "./card-faces";

const PROJECT_REF = "tracker:project:p1";

const TICKET: ActiveEntityKind = {
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
const text = (key: string, value: string): TitledFieldRow => ({
  ref: "tracker:ticket:1",
  key,
  text_value: value,
  number_value: null,
  title: value === PROJECT_REF ? "Apollo" : null,
});

const number = (key: string, value: number): TitledFieldRow => ({
  ref: "tracker:ticket:1",
  key,
  text_value: null,
  number_value: value,
  title: null,
});

describe("drawFieldsAndCardFace", () => {
  it("decodes each type and returns the values in declaration order", () => {
    const rows = [
      number("blocked", 1),
      text("note", "hello"),
      number("opened", Date.UTC(2026, 0, 2)),
      number("budget", 12.5),
      number("estimate", 3),
      text("priority", "p1"),
      text("assignee", "Ada"),
      text("project", PROJECT_REF),
    ];
    const { fields } = drawFieldsAndCardFace(TICKET, rows);
    expect(fields).toEqual([
      { key: "project", label: "Project", type: "text", text: "Apollo", ref: PROJECT_REF },
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
    const { fields } = drawFieldsAndCardFace(TICKET, [
      text("priority", "p2"),
      number("blocked", 0),
    ]);
    expect(fields).toEqual([
      { key: "priority", label: "Priority", type: "enum", value: "p2", text: "p2" },
      { key: "blocked", label: "Blocked", type: "bool", value: false },
    ]);
  });

  it("fills the face slots and leaves out a slot whose field has no value", () => {
    const rows = [text("project", PROJECT_REF), number("budget", 5)];
    const { face } = drawFieldsAndCardFace(TICKET, rows);
    expect(face).toEqual({
      place: { key: "project", label: "Project", type: "text", text: "Apollo", ref: PROJECT_REF },
      fact: { key: "budget", label: "Budget", type: "money", amount: 5, currency: "EUR" },
    });
  });

  it("ignores a row of an undeclared key", () => {
    const { fields } = drawFieldsAndCardFace(TICKET, [text("gone", "x")]);
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
      { ref: "tracker:ticket:1", key: "note", text_value: "a", number_value: 1, title: null },
      { ref: "tracker:ticket:1", key: "budget", text_value: null, number_value: null, title: null },
    ];
    expect(drawFieldsAndCardFace(TICKET, rows)).toEqual({ fields: [], face: {} });
  });

  it("gives no fields and no face for a kind that is not active", () => {
    expect(drawFieldsAndCardFace(undefined, [text("note", "x")])).toEqual({
      fields: [],
      face: null,
    });
  });

  it("gives a null face for a kind that declares none", () => {
    const withoutFace: ActiveEntityKind = {
      kind: TICKET.kind,
      noun: TICKET.noun,
      refPrefix: TICKET.refPrefix,
      fields: TICKET.fields!,
    };
    const { face, fields } = drawFieldsAndCardFace(withoutFace, [text("note", "x")]);
    expect(face).toBeNull();
    expect(fields).toHaveLength(1);
  });
});

describe("a ref-valued field", () => {
  it("is left out, and so is the face slot that names it, when its record has no readable title", () => {
    const unreadable: TitledFieldRow = { ...text("project", PROJECT_REF), title: null };
    const { fields, face } = drawFieldsAndCardFace(TICKET, [unreadable]);
    expect(fields).toEqual([]);
    expect(face).toEqual({});
  });
});
