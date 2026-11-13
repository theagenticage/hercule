/** Tests how a stored record and its field values become the entry of a prompt's context block. */
import { describe, expect, it } from "vitest";
import type { EntityFieldValue } from "@hercule/contract";
import { buildPromptContextThing } from "./prompt-context";
import type { TaskableEntity } from "./repository";

const identity = { key: "k", label: "Label" };

const record = (overrides: Partial<TaskableEntity> = {}): TaskableEntity => ({
  id: "0199f0b7-0000-7000-8000-000000000001",
  ref: "acme:ticket:1",
  kind: "acme/ticket",
  completeness: "full",
  isWorkRecord: true,
  noun: "Ticket",
  identifier: "ACME-1",
  title: "Fix the cart",
  status: { shape: "half", tone: "active", label: "In progress" },
  stage: undefined,
  targetRemote: undefined,
  access: "ok",
  hasConcern: false,
  ...overrides,
});

const valueOf = (field: EntityFieldValue) =>
  buildPromptContextThing(record(), [field]).fields[0]!.value;

describe("buildPromptContextThing", () => {
  it.each<[EntityFieldValue, string]>([
    [{ ...identity, type: "text", text: "Storefront" }, "Storefront"],
    [{ ...identity, type: "person", text: "Mei" }, "Mei"],
    [{ ...identity, type: "enum", value: "high", text: "High" }, "High"],
    [{ ...identity, type: "number", number: 3.5 }, "3.5"],
    [{ ...identity, type: "money", amount: 1200, currency: "GBP" }, "1200 GBP"],
    [{ ...identity, type: "age", since: "2026-03-01T00:00:00.000Z" }, "2026-03-01T00:00:00.000Z"],
    [{ ...identity, type: "bool", value: true }, "yes"],
    [{ ...identity, type: "bool", value: false }, "no"],
  ])("writes the field %j as %s", (field, text) => {
    expect(valueOf(field)).toBe(text);
  });

  it("carries the ref of a text field that names another record, so equal titles stay apart", () => {
    const thing = buildPromptContextThing(record(), [
      { ...identity, type: "text", text: "Checkout", ref: "acme:project:9" },
    ]);
    expect(thing.fields).toEqual([
      { key: "k", type: "text", label: "Label", value: "Checkout", ref: "acme:project:9" },
    ]);
  });

  it.each(["full", "partial"] as const)(
    "gives a %s record that no Connection can read only its ref and id",
    (completeness) => {
      const thing = buildPromptContextThing(record({ completeness, access: "inaccessible" }), [
        { ...identity, type: "text", text: "Storefront" },
      ]);
      expect(thing).toEqual({
        entityId: "0199f0b7-0000-7000-8000-000000000001",
        ref: "acme:ticket:1",
        fields: [],
      });
    },
  );

  it("gives a readable record its title, status and fields", () => {
    expect(buildPromptContextThing(record({ completeness: "partial" }), [])).toMatchObject({
      title: "Fix the cart",
      status: "In progress",
    });
  });
});
