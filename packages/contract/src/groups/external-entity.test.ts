/**
 * Tests that the typed field values and the card face of an External Entity
 * survive the contract's schema in both directions, in particular the `ref` of
 * a field that holds the record of a context kind.
 */
import { describe, expect, it } from "vitest";
import { Schema } from "effect";
import { readShorthandDecoder } from "../shorthand";
import {
  CardFace,
  EntityFieldValue,
  InboxGroup,
  InboxQuery,
  MAX_INBOX_PAGE,
} from "./external-entity";

const PROJECT_FIELD = {
  key: "project",
  label: "Project",
  type: "text",
  text: "Apollo",
  ref: "linear:project:p1",
} as const;

describe("EntityFieldValue", () => {
  it("keeps the ref of a text field on decode and on encode", () => {
    const decoded = Schema.decodeUnknownSync(EntityFieldValue)(PROJECT_FIELD);
    expect(decoded).toEqual(PROJECT_FIELD);
    expect(Schema.encodeSync(EntityFieldValue)(decoded)).toEqual(PROJECT_FIELD);
  });

  it("takes a text field with no ref, and a person", () => {
    const text = { key: "note", label: "Note", type: "text", text: "x" } as const;
    const person = { key: "owner", label: "Owner", type: "person", text: "Marta" } as const;
    expect(Schema.decodeUnknownSync(EntityFieldValue)(text)).toEqual(text);
    expect(Schema.decodeUnknownSync(EntityFieldValue)(person)).toEqual(person);
  });
});

describe("CardFace", () => {
  it("keeps the ref of a ref-valued slot", () => {
    const face = { place: PROJECT_FIELD };
    expect(Schema.decodeUnknownSync(CardFace)(face)).toEqual(face);
    expect(Schema.encodeSync(CardFace)(face)).toEqual(face);
  });
});

describe("the typed clause word of `entity list --clause`", () => {
  const decodeWord = readShorthandDecoder(InboxQuery.members[0].to.fields.clauses)!;

  it("keeps the value as the raw text, for the controller to read for the field's type", () => {
    expect(decodeWord("waiting>2d")).toEqual({ key: "waiting", op: "over", value: "2d" });
    expect(decodeWord("team=2d")).toEqual({ key: "team", op: "is", value: "2d" });
    expect(decodeWord("asks=true")).toEqual({ key: "asks", op: "is", value: "true" });
    expect(decodeWord("size>1000")).toEqual({ key: "size", op: "over", value: "1000" });
  });

  it("refuses a word that is not a clause, with what to write", () => {
    expect(() => decodeWord("nonsense")).toThrow(/Write key=value/);
  });
});

describe("the `limit` of a first page", () => {
  const decode = Schema.decodeUnknownExit(InboxQuery);
  const first = { mode: "first", list: { savedQuery: "waits" } };

  it("is optional, from 1 to a whole page, and only for the first page", () => {
    expect(decode(first)._tag).toBe("Success");
    expect(decode({ ...first, limit: 1 })._tag).toBe("Success");
    expect(decode({ ...first, limit: MAX_INBOX_PAGE })._tag).toBe("Success");
    expect(decode({ ...first, limit: 0 })._tag).toBe("Failure");
    expect(decode({ ...first, limit: MAX_INBOX_PAGE + 1 })._tag).toBe("Failure");
    expect(decode({ ...first, limit: 1.5 })._tag).toBe("Failure");
    expect(decode({ mode: "next", list: first.list, after: "x", limit: 5 })._tag).toBe("Failure");
  });
});

describe("InboxGroup", () => {
  const member = (ref: string) => ({
    id: "0190c000-0000-7000-8000-000000000001",
    ref,
    matches: true,
  });

  it("needs at least two members and a size of at least two", () => {
    const decode = Schema.decodeUnknownExit(InboxGroup);
    const group = {
      labelRef: "acme:ticket:1",
      label: "A",
      members: [member("acme:ticket:1"), member("acme:ticket:2")],
      size: 2,
    };
    expect(decode(group)._tag).toBe("Success");
    expect(decode({ ...group, size: 1 })._tag).toBe("Failure");
    expect(decode({ ...group, members: [member("acme:ticket:1")] })._tag).toBe("Failure");
  });
});
