/**
 * Tests how a stored record becomes a small card: its fields, what a record
 * with no identifier or title leaves out, and the kind it falls back to. Which
 * records are restricted is tested through the service, where the access of a
 * record is read from its observations.
 */
import { describe, expect, it } from "vitest";
import { buildEntityCard } from "./entity-cards";
import type { ActiveEntityKind } from "./entity-records";
import type { TaskableEntity } from "./repository";

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

const ticketKind = {
  kind: "acme/ticket",
  noun: "Ticket",
  refPrefix: "acme:ticket:",
} as ActiveEntityKind;

describe("buildEntityCard", () => {
  it("gives a readable record what its rows hold, with the face", () => {
    const face = {
      place: { key: "team", label: "Team", type: "person", text: "Storefront" },
    } as const;
    expect(buildEntityCard(record(), face, [ticketKind])).toEqual({
      id: "0199f0b7-0000-7000-8000-000000000001",
      ref: "acme:ticket:1",
      kind: "acme/ticket",
      noun: "Ticket",
      identifier: "ACME-1",
      title: "Fix the cart",
      status: { shape: "half", tone: "active", label: "In progress" },
      card: "compact",
      face,
      restricted: false,
    });
  });

  it("leaves out the identifier and title a partial record does not hold yet", () => {
    const card = buildEntityCard(record({ identifier: "", title: "", status: undefined }), null, [
      ticketKind,
    ]);
    expect(card).not.toHaveProperty("title");
    expect(card).not.toHaveProperty("identifier");
    expect(card).toMatchObject({ restricted: false, face: null });
  });

  it("takes the kind and noun of the kind that owns the ref when none is stored, and gives no card when none owns it", () => {
    const bare = record({ kind: "", noun: "" });
    expect(buildEntityCard(bare, null, [ticketKind])).toMatchObject({
      kind: "acme/ticket",
      noun: "Ticket",
    });
    expect(buildEntityCard(bare, null, [])).toBeUndefined();
  });
});
