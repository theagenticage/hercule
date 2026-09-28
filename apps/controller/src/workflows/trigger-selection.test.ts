/**
 * Tests which events a start trigger wants before its filter runs: the kind
 * must match, a named Connection must be the event's, and a `cron.tick` is
 * wanted only by the trigger it was written for, and only when the Scheduler
 * wrote it.
 */
import { describe, expect, it } from "vitest";
import { ANY_CONNECTION, type Event } from "@hercule/contract";
import type { RoutableStartTrigger } from "./repository";
import { admitsEvent } from "./trigger-selection";

const WORKFLOW_ID = "0199e0e7-0000-7000-8000-00000000a001";
const OTHER_WORKFLOW_ID = "0199e0e7-0000-7000-8000-00000000a002";
const CONNECTION_ID = "0199e0e7-0000-7000-8000-00000000c001";
const OTHER_CONNECTION_ID = "0199e0e7-0000-7000-8000-00000000c002";

/** Returns a start trigger on `github.issue.opened`, with `fields` replacing the defaults. */
const buildTrigger = (fields: Partial<RoutableStartTrigger> = {}): RoutableStartTrigger => ({
  workflowId: WORKFLOW_ID,
  triggerId: "on-issue",
  eventKind: "github.issue.opened",
  connectionId: undefined,
  filter: undefined,
  inputs: {},
  hasHealthError: false,
  ...fields,
});

/** Returns a `github.issue.opened` event through `CONNECTION_ID`, with `fields` replacing the defaults. */
const buildEvent = (fields: Partial<Event> = {}): Event => ({
  id: 1,
  source: "github",
  connectionId: CONNECTION_ID,
  system: "github",
  kind: "github.issue.opened",
  occurredAt: "2026-09-01T09:00:00.000Z",
  receivedAt: "2026-09-01T09:00:01.000Z",
  dedupKey: "delivery-1",
  refs: [],
  url: null,
  payload: {},
  raw: null,
  actor: null,
  ...fields,
});

/** Returns the `cron.tick` the Scheduler writes for trigger `nightly` of `WORKFLOW_ID`, with `fields` replacing the defaults. */
const buildCronTick = (fields: Partial<Event> = {}): Event =>
  buildEvent({
    source: "cron",
    connectionId: null,
    system: "cron",
    kind: "cron.tick",
    dedupKey: `${WORKFLOW_ID}/nightly/2026-09-01T09:00:00.000Z`,
    payload: {
      workflowId: WORKFLOW_ID,
      triggerId: "nightly",
      scheduledFor: "2026-09-01T09:00:00.000Z",
      previousFiredAt: null,
    },
    ...fields,
  });

const CRON_TRIGGER = buildTrigger({ triggerId: "nightly", eventKind: "cron.tick" });

describe("admitsEvent", () => {
  it("refuses an event of another kind", () => {
    expect(admitsEvent(buildTrigger(), buildEvent({ kind: "github.issue.closed" }))).toBe(false);
  });

  it("admits an event of the trigger's kind through the Connection the trigger names", () => {
    expect(admitsEvent(buildTrigger({ connectionId: CONNECTION_ID }), buildEvent())).toBe(true);
  });

  it("refuses an event through another Connection than the one the trigger names", () => {
    expect(
      admitsEvent(
        buildTrigger({ connectionId: CONNECTION_ID }),
        buildEvent({ connectionId: OTHER_CONNECTION_ID }),
      ),
    ).toBe(false);
  });

  it("refuses an event through no Connection when the trigger names one", () => {
    expect(
      admitsEvent(
        buildTrigger({ connectionId: CONNECTION_ID }),
        buildEvent({ connectionId: null }),
      ),
    ).toBe(false);
  });

  it("admits an event through any Connection, or none, when the trigger names no Connection or any", () => {
    for (const connectionId of [undefined, ANY_CONNECTION]) {
      const trigger = buildTrigger({ connectionId });
      expect(admitsEvent(trigger, buildEvent())).toBe(true);
      expect(admitsEvent(trigger, buildEvent({ connectionId: OTHER_CONNECTION_ID }))).toBe(true);
      expect(admitsEvent(trigger, buildEvent({ connectionId: null }))).toBe(true);
    }
  });

  it("admits a cron tick the Scheduler wrote for this trigger", () => {
    expect(admitsEvent(CRON_TRIGGER, buildCronTick())).toBe(true);
  });

  it("refuses a cron tick that was not written by the Scheduler, even when its payload names this trigger", () => {
    expect(admitsEvent(CRON_TRIGGER, buildCronTick({ source: "manual" }))).toBe(false);
  });

  it("refuses a cron tick for another trigger of the same workflow", () => {
    const tick = buildCronTick();
    expect(
      admitsEvent(CRON_TRIGGER, { ...tick, payload: { ...tick.payload, triggerId: "hourly" } }),
    ).toBe(false);
  });

  it("refuses a cron tick for a trigger with the same id in another workflow", () => {
    const tick = buildCronTick();
    expect(
      admitsEvent(CRON_TRIGGER, {
        ...tick,
        payload: { ...tick.payload, workflowId: OTHER_WORKFLOW_ID },
      }),
    ).toBe(false);
  });

  it("refuses a cron tick whose payload names no trigger", () => {
    expect(admitsEvent(CRON_TRIGGER, buildCronTick({ payload: {} }))).toBe(false);
  });
});
