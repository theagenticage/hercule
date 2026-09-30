/**
 * Tests `createTailBuffer`: taps build an item's tail, stream rows remove the
 * text they hold from its front, and an item that may have missed a tap is
 * skipped until it completes.
 */
import { describe, expect, it } from "vitest";
import type { TapItem, TranscriptRow } from "@hercule/contract";
import { createTailBuffer } from "./tail-buffer";

const AT = "2026-09-30T09:00:00.000Z";

const buildTap = (
  itemId: string,
  delta: string,
  streamKind: TapItem["streamKind"] = "assistant_text",
): TapItem => ({
  turnId: "t1",
  itemId,
  streamKind,
  delta,
});

let position = 0;

const buildRow = (event: TranscriptRow["event"]): TranscriptRow => ({
  position: ++position,
  at: event.at,
  event,
});

const buildTextRow = (itemId: string, delta: string): TranscriptRow =>
  buildRow({
    _tag: "content.delta",
    eventId: `e${position}`,
    sessionId: "s1",
    at: AT,
    turnId: "t1",
    itemId,
    streamKind: "assistant_text",
    delta,
  });

const buildItemStarted = (itemId: string): TranscriptRow =>
  buildRow({
    _tag: "item.started",
    eventId: `e${position}`,
    sessionId: "s1",
    at: AT,
    turnId: "t1",
    itemId,
    kind: "assistant_message",
  });

const buildItemCompleted = (itemId: string): TranscriptRow =>
  buildRow({
    _tag: "item.completed",
    eventId: `e${position}`,
    sessionId: "s1",
    at: AT,
    turnId: "t1",
    itemId,
    kind: "assistant_message",
    status: "completed",
  });

describe("createTailBuffer", () => {
  it("starts with no tail", () => {
    const tail = createTailBuffer();

    expect(tail.read("a1")).toBe("");
    expect(tail.read(null)).toBe("");
  });

  it("appends an item's assistant text taps to its tail, one tail per item", () => {
    const tail = createTailBuffer();

    tail.appendTap(buildTap("a1", "Hel"));
    tail.appendTap(buildTap("a2", "Other"));
    tail.appendTap(buildTap("a1", "lo"));

    expect(tail.read("a1")).toBe("Hello");
    expect(tail.read("a2")).toBe("Other");
  });

  it("keeps a tap that arrives before its item's item.started row", () => {
    const tail = createTailBuffer();

    tail.appendTap(buildTap("a1", "Early"));
    tail.applyRows([buildItemStarted("a1")]);

    expect(tail.read("a1")).toBe("Early");
  });

  it("ignores reasoning and command output taps", () => {
    const tail = createTailBuffer();

    tail.appendTap(buildTap("a1", "thinking", "reasoning_text"));
    tail.appendTap(buildTap("a1", "$ ls", "command_output"));

    expect(tail.read("a1")).toBe("");
  });

  it("removes a row's text from the front of the tail and keeps the text after the row's cut", () => {
    // The 4 KB flush: the taps after the cut arrived before the row did.
    const tail = createTailBuffer();
    const cut = "x".repeat(4 * 1024);
    tail.appendTap(buildTap("a1", cut));
    tail.appendTap(buildTap("a1", ", and more"));

    tail.applyRows([buildTextRow("a1", cut)]);

    expect(tail.read("a1")).toBe(", and more");
  });

  it("empties the tail when a row holds all of it", () => {
    const tail = createTailBuffer();
    tail.appendTap(buildTap("a1", "Hello world"));

    tail.applyRows([buildTextRow("a1", "Hello world")]);

    expect(tail.read("a1")).toBe("");
  });

  it("leaves an item's tail alone when a row for another item lands", () => {
    const tail = createTailBuffer();
    tail.appendTap(buildTap("a1", "Hello"));
    tail.appendTap(buildTap("a2", "Other"));

    tail.applyRows([buildTextRow("a2", "Other"), buildItemCompleted("tool1")]);

    expect(tail.read("a1")).toBe("Hello");
  });

  it("skips an item whose tail does not start with a row's text, until the item completes", () => {
    const tail = createTailBuffer();
    tail.appendTap(buildTap("a1", "lo world"));

    tail.applyRows([buildTextRow("a1", "Hello world")]);
    tail.appendTap(buildTap("a1", ", again"));

    expect(tail.read("a1")).toBe("");

    // The next message of the same thread streams as normal.
    tail.appendTap(buildTap("a2", "Next"));
    expect(tail.read("a2")).toBe("Next");
  });

  it("skips an item whose tail is shorter than a row's text, because it missed taps", () => {
    const tail = createTailBuffer();
    tail.appendTap(buildTap("a1", "Hello "));

    tail.applyRows([buildTextRow("a1", "Hello world")]);
    tail.appendTap(buildTap("a1", ", again"));

    expect(tail.read("a1")).toBe("");
  });

  it("forgets a skipped item when it completes", () => {
    const tail = createTailBuffer();
    tail.applyRows([buildTextRow("a1", "missed")]);
    tail.appendTap(buildTap("a1", "dropped"));
    expect(tail.read("a1")).toBe("");

    tail.applyRows([buildItemCompleted("a1")]);
    tail.appendTap(buildTap("a1", "kept"));

    expect(tail.read("a1")).toBe("kept");
  });

  it("forgets a completed item's tail", () => {
    const tail = createTailBuffer();
    tail.appendTap(buildTap("a1", "Hello"));

    tail.applyRows([buildTextRow("a1", "Hello"), buildItemCompleted("a1")]);

    expect(tail.read("a1")).toBe("");
  });

  it("skips the items open in the rows when the tap is subscribed mid-item", () => {
    const tail = createTailBuffer();
    const held = [buildItemStarted("done"), buildItemCompleted("done"), buildItemStarted("a1")];

    tail.skipOpenItems(held);
    tail.appendTap(buildTap("a1", "rest of a sentence"));

    expect(tail.read("a1")).toBe("");

    // Its rows still land, and its completion ends the skip.
    tail.applyRows([buildTextRow("a1", "Whole sentence, rest of a sentence")]);
    tail.applyRows([buildItemCompleted("a1")]);
    tail.appendTap(buildTap("a1", "after"));
    expect(tail.read("a1")).toBe("after");
  });

  it("streams an item that starts after the tap is subscribed", () => {
    const tail = createTailBuffer();
    tail.skipOpenItems([buildItemStarted("done"), buildItemCompleted("done")]);

    tail.appendTap(buildTap("a2", "Fresh"));

    expect(tail.read("a2")).toBe("Fresh");
  });

  it("skips every item it holds a tail for when the tap is subscribed again", () => {
    // The rows the caller holds may not show the item open yet, but a tail
    // held from before the gap has missed the taps sent during it.
    const tail = createTailBuffer();
    tail.appendTap(buildTap("a1", "Before the gap"));

    tail.skipOpenItems([]);
    tail.appendTap(buildTap("a1", " after the gap"));

    expect(tail.read("a1")).toBe("");
  });

  it("drops every tail and skips its item when the stream is reset", () => {
    const tail = createTailBuffer();
    tail.appendTap(buildTap("a1", "stale"));
    tail.appendTap(buildTap("a2", "stale too"));

    tail.skipOpenItems([buildItemStarted("a1")]);

    expect(tail.read("a1")).toBe("");
    expect(tail.read("a2")).toBe("");
    tail.appendTap(buildTap("a2", "more"));
    expect(tail.read("a2")).toBe("");
  });
});
