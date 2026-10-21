/** Tests how the Tasks the controller names as Your work are matched to the signals on To do. */
import type { Signal, YourWorkTask } from "@hercule/contract";
import { describe, expect, it } from "vitest";
import { matchYourWork } from "./your-work";

const buildSignal = (id: string): Signal => ({
  id,
  kind: "github/review-requested",
  origin: { type: "event", eventId: 1, connectionId: "conn-1", threadRef: "github:pr:acme/shop#1" },
  title: `Signal ${id}`,
  priority: "normal",
  blocks: [],
  actions: [],
  match: {},
  status: "open",
  createdAt: "2026-10-10T09:00:00.000Z",
});

const buildTask = (id: string, signalIds: ReadonlyArray<string>): YourWorkTask => ({
  id,
  title: `Task ${id}`,
  status: "open",
  updatedAt: "2026-10-10T09:00:00.000Z",
  signalIds,
});

describe("matchYourWork", () => {
  const taskIds = (yourWork: ReturnType<typeof matchYourWork>, signalId: string) =>
    yourWork.get(signalId)?.tasks.map((task) => task.id);

  it("gives a signal the Tasks that name it, in the order the controller listed them", () => {
    const signal = buildSignal("a");
    const yourWork = matchYourWork(
      [signal, buildSignal("b"), buildSignal("c")],
      [buildTask("t2", ["a", "b"]), buildTask("t1", ["a"]), buildTask("t3", ["unknown"])],
    );
    expect(taskIds(yourWork, "a")).toEqual(["t2", "t1"]);
    expect(taskIds(yourWork, "b")).toEqual(["t2"]);
    expect(yourWork.get("a")?.signal).toBe(signal);
    expect(yourWork.has("c")).toBe(false);
  });

  it("drops a signal the user moved off To do, whatever the controller last said", () => {
    const tasks = [buildTask("t1", ["a", "b"])];
    expect([...matchYourWork([buildSignal("a"), buildSignal("b")], tasks).keys()]).toEqual([
      "a",
      "b",
    ]);
    expect([...matchYourWork([buildSignal("b")], tasks).keys()]).toEqual(["b"]);
  });
});
