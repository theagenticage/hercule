/**
 * `openItemOf(rows)` finds the one item still in flight, if any: the last
 * `item.started` with no matching `item.completed`. Fixtures follow the same
 * shapes `turns.test.ts` uses (spec 06 §6.3).
 */
import { describe, expect, it } from "vitest";
import type { TranscriptRow } from "@hydra/contract";
import { openItemOf } from "./open-item";

const SESSION_ID = "session-1";

let idSeq = 0;
const nextId = (): string => `e${idSeq++}`;

const row = (event: TranscriptRow["event"]): TranscriptRow => ({
  position: idSeq,
  at: event.at,
  event,
});

type ItemKindType = Extract<TranscriptRow["event"], { _tag: "item.started" }>["kind"];

const started = (itemId: string, kind: ItemKindType, at = "2026-09-08T10:00:00.000Z") =>
  row({
    _tag: "item.started",
    eventId: nextId(),
    sessionId: SESSION_ID,
    at,
    turnId: "t1",
    itemId,
    kind,
    detail: {},
  });

const completed = (itemId: string, kind: ItemKindType, at = "2026-09-08T10:00:01.000Z") =>
  row({
    _tag: "item.completed",
    eventId: nextId(),
    sessionId: SESSION_ID,
    at,
    turnId: "t1",
    itemId,
    kind,
    status: "completed",
    detail: {},
  });

describe("openItemOf", () => {
  it("is nothing when there are no rows, or every item has completed", () => {
    expect(openItemOf([])).toBeNull();
    expect(openItemOf([started("i1", "tool_call"), completed("i1", "tool_call")])).toBeNull();
  });

  it("is the item whose item.started has no item.completed yet", () => {
    const rows = [started("i1", "assistant_message"), started("i2", "tool_call")];
    expect(openItemOf(rows)).toBe("i2");
  });

  it("ignores a user_message: it is complete the moment it is sent", () => {
    const rows = [started("u1", "user_message")];
    expect(openItemOf(rows)).toBeNull();
  });

  it("falls back to an earlier still-open item once the most recent one completes", () => {
    const rows = [
      started("i1", "tool_call"),
      started("i2", "tool_call"),
      completed("i2", "tool_call"),
    ];
    expect(openItemOf(rows)).toBe("i1");
  });
});
