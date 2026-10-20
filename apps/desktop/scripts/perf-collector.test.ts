import { describe, expect, it } from "vitest";
import { createFrameTracker } from "./perf-collector.ts";

// Frames as the live connection carries them: Effect RPC over JSON. A
// subscription is a `Request` of the method `subscribe`; the controller
// answers with `Chunk`s for it, and a `Pong` for each keepalive.
const subscribe = (id: number, topic: string) =>
  JSON.stringify({ _tag: "Request", id, tag: "subscribe", payload: { topic } });
const chunk = (requestId: number, ...kinds: string[]) =>
  JSON.stringify({ _tag: "Chunk", requestId, values: kinds.map((_tag) => ({ _tag, ids: [] })) });

describe("createFrameTracker", () => {
  it("counts only the invalidations of a subscription as pushes, not keepalives or other frames", () => {
    const tracker = createFrameTracker();
    tracker.readFrame("socket", subscribe(1, "task"));
    expect(tracker.readFrame("socket", JSON.stringify({ _tag: "Ping" }))).toEqual([]);
    expect(tracker.readFrame("socket", JSON.stringify({ _tag: "Pong" }))).toEqual([]);
    expect(tracker.readFrame("socket", chunk(9, "invalidate"))).toEqual([]);
    expect(tracker.readFrame("socket", chunk(1, "append"))).toEqual([]);
    expect(tracker.readFrame("socket", "not json")).toEqual([]);
  });

  it("marks the first message after subscribing as initial and later ones as changes", () => {
    const tracker = createFrameTracker();
    tracker.readFrame("socket", subscribe(1, "run"));
    expect(tracker.readFrame("socket", chunk(1, "invalidate"))).toEqual([
      { topic: "run", initial: true },
    ]);
    expect(tracker.readFrame("socket", chunk(1, "invalidate", "invalidate"))).toEqual([
      { topic: "run", initial: false },
      { topic: "run", initial: false },
    ]);
  });

  it("reads a frame that carries a list of messages", () => {
    const tracker = createFrameTracker();
    const frame = `[${subscribe(1, "task")},${subscribe(2, "run")}]`;
    tracker.readFrame("socket", frame);
    expect(tracker.listHeldTopics()).toEqual(["run", "task"]);
  });

  it("holds a topic until the page interrupts it or the controller ends it", () => {
    const tracker = createFrameTracker();
    tracker.readFrame("socket", subscribe(1, "task"));
    tracker.readFrame("socket", subscribe(2, "run"));
    tracker.readFrame("socket", subscribe(3, "signal"));
    tracker.readFrame("socket", JSON.stringify({ _tag: "Interrupt", requestId: 2 }));
    tracker.readFrame("socket", JSON.stringify({ _tag: "Exit", requestId: 3, exit: {} }));
    expect(tracker.listHeldTopics()).toEqual(["task"]);
  });

  it("keeps the subscriptions of two sockets apart, though their call ids repeat", () => {
    const tracker = createFrameTracker();
    tracker.readFrame("first", subscribe(1, "task"));
    tracker.readFrame("second", subscribe(1, "run"));
    expect(tracker.readFrame("second", chunk(1, "invalidate"))).toEqual([
      { topic: "run", initial: true },
    ]);
    tracker.forgetSocket("first");
    expect(tracker.listHeldTopics()).toEqual(["run"]);
  });
});
