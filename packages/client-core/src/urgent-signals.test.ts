/**
 * Tests which open signals the desktop app notifies: the urgent ones about an
 * External Entity, oldest first, titled with their source.
 */
import type { Signal } from "@hercule/contract";
import { describe, expect, it } from "vitest";
import { listUrgentSignals } from "./urgent-signals";

const PLUGINS = [
  { id: "github", displayName: "GitHub" },
  { id: "slack", displayName: "Slack" },
];

const EVENT_ORIGIN = {
  type: "event",
  eventId: 1,
  connectionId: "01a06d02-7200-7000-8000-000000000001",
  threadRef: "acme/webshop#1296",
} as const;

/** Builds an open signal of `kind`, created at `createdAt`, with the given fields changed. */
const buildSignal = (id: string, overrides: Partial<Signal> = {}): Signal => ({
  id,
  kind: "github/mentioned",
  origin: EVENT_ORIGIN,
  title: `Signal ${id}`,
  priority: "normal",
  blocks: [],
  actions: [],
  match: {},
  status: "open",
  createdAt: "2026-10-10T09:00:00.000Z",
  ...overrides,
});

/** Builds the fields of a signal about the thing `ref`: its origin, which names the ref, and the entity found by it. */
const buildAbout = (ref: string): Pick<Signal, "origin" | "entity"> => ({
  origin: { ...EVENT_ORIGIN, threadRef: ref },
  entity: {
    id: "01a06d02-7300-7000-8000-000000000001",
    kind: "github/pull-request",
    identifier: "#1296",
    title: "Fix the checkout",
  },
});

describe("listUrgentSignals", () => {
  it("lists the urgent signals about an entity, oldest first, titled with their source", () => {
    expect(
      listUrgentSignals(
        [
          buildSignal("late", {
            priority: "urgent",
            createdAt: "2026-10-10T10:00:00.000Z",
            ...buildAbout("github:pr:acme/webshop#1296"),
          }),
          buildSignal("calm", buildAbout("github:pr:acme/webshop#1297")),
          buildSignal("early", {
            kind: "slack/mentioned",
            priority: "urgent",
            title: "Checkout is down",
            createdAt: "2026-10-10T08:00:00.000Z",
            ...buildAbout("slack:thread:acme/C1#42"),
          }),
        ],
        PLUGINS,
      ),
    ).toEqual([
      {
        signalId: "early",
        ref: "slack:thread:acme/C1#42",
        title: "Slack",
        body: "Checkout is down",
      },
      {
        signalId: "late",
        ref: "github:pr:acme/webshop#1296",
        title: "GitHub",
        body: "Signal late",
      },
    ]);
  });

  it("leaves out an urgent signal about no entity, which has no place in the app to open", () => {
    expect(listUrgentSignals([buildSignal("alone", { priority: "urgent" })], PLUGINS)).toEqual([]);
  });
});
