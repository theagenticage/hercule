/**
 * Tests how stored records and their field values become the input of a
 * prompt's context block: the entry of each thing and the block's origin.
 * Which records are restricted is also tested through the service, where the
 * access of a record is read from its observations.
 */
import { describe, expect, it } from "vitest";
import type { EntityFieldValue } from "@hercule/contract";
import { buildPromptContextOrigin, buildPromptContextThing } from "./prompt-context";
import type { TaskableEntity } from "./repository";

const identity = { key: "k", label: "Label" };

const record = (overrides: Partial<TaskableEntity> = {}): TaskableEntity => ({
  id: "0199f0b7-0000-7000-8000-000000000001",
  ref: "acme:ticket:1",
  kind: "acme/ticket",
  completeness: "full",
  isWorkRecord: true,
  noun: "Ticket",
  card: "compact",
  identifier: "ACME-1",
  title: "Fix the cart",
  status: { shape: "half", tone: "active", label: "In progress" },
  stage: undefined,
  targetRemote: undefined,
  access: "ok",
  hasConcern: false,
  ...overrides,
});

describe("buildPromptContextThing", () => {
  it("gives a record its title, the label of its status and its field values", () => {
    const field: EntityFieldValue = { ...identity, type: "text", text: "Checkout" };
    expect(buildPromptContextThing(record(), [field])).toMatchObject({
      title: "Fix the cart",
      status: "In progress",
      fields: [field],
    });
  });

  it("leaves out the title of a record that has none", () => {
    expect(buildPromptContextThing(record({ title: "" }), [])).not.toHaveProperty("title");
  });
});

describe("buildPromptContextOrigin", () => {
  const first = record({ ref: "acme:ticket:1", title: "First" });
  const second = record({ ref: "acme:ticket:2", title: "Second" });

  it("is one for a single record, a selection for records with no label, and a group with a label", () => {
    expect(buildPromptContextOrigin(undefined, [first])).toEqual({ kind: "one" });
    expect(buildPromptContextOrigin(undefined, [first, second])).toEqual({ kind: "selection" });
    expect(buildPromptContextOrigin(second.ref, [first, second])).toEqual({
      kind: "group",
      label: "Second",
    });
  });

  it("labels a group by the locked label when its label thing is a restricted place", () => {
    const locked = record({ ref: "acme:ticket:2", isWorkRecord: false, access: "inaccessible" });
    expect(buildPromptContextOrigin(locked.ref, [first, locked])).toEqual({
      kind: "group",
      label: "A ticket you cannot open",
    });
  });
});
