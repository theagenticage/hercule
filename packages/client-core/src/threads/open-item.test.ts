/**
 * Tests `findOpenItem(rows)`, which finds the item still in progress, if any:
 * the last `item.started` with no matching `item.completed`. The fixtures
 * have the same shapes as in `turns.test.ts` (spec 06 §6.3).
 */
import { describe, expect, it } from "vitest";
import type { TranscriptRow } from "@hercule/contract";
import { findOpenItem } from "./open-item";

const SESSION_ID = "session-1";

let idSeq = 0;
const nextId = (): string => `e${idSeq++}`;

const buildRow = (event: TranscriptRow["event"]): TranscriptRow => ({
  position: idSeq,
  at: event.at,
  event,
});

type ItemKindType = Extract<TranscriptRow["event"], { _tag: "item.started" }>["kind"];

const buildStartedRow = (itemId: string, kind: ItemKindType, at = "2026-09-08T10:00:00.000Z") =>
  buildRow({
    _tag: "item.started",
    eventId: nextId(),
    sessionId: SESSION_ID,
    at,
    turnId: "t1",
    itemId,
    kind,
    detail: {},
  });

const buildCompletedRow = (itemId: string, kind: ItemKindType, at = "2026-09-08T10:00:01.000Z") =>
  buildRow({
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

describe("findOpenItem", () => {
  it("returns null when there are no rows, or every item has completed", () => {
    expect(findOpenItem([])).toBeNull();
    expect(
      findOpenItem([buildStartedRow("i1", "tool_call"), buildCompletedRow("i1", "tool_call")]),
    ).toBeNull();
  });

  it("returns the item whose item.started has no item.completed yet", () => {
    const rows = [buildStartedRow("i1", "assistant_message"), buildStartedRow("i2", "tool_call")];
    expect(findOpenItem(rows)).toBe("i2");
  });

  it("ignores a user_message: it is complete the moment it is sent", () => {
    const rows = [buildStartedRow("u1", "user_message")];
    expect(findOpenItem(rows)).toBeNull();
  });

  it("falls back to an earlier still-open item once the most recent one completes", () => {
    const rows = [
      buildStartedRow("i1", "tool_call"),
      buildStartedRow("i2", "tool_call"),
      buildCompletedRow("i2", "tool_call"),
    ];
    expect(findOpenItem(rows)).toBe("i1");
  });
});
