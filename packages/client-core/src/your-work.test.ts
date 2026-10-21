/** Tests how Your work is read for the signals on screen and matched back to them. */
import { MAX_FILTER_VALUES, type Signal, type Task } from "@hercule/contract";
import { describe, expect, it } from "vitest";
import {
  batchYourWorkRefs,
  isYourWorkReadOutdated,
  listSignalsWithThreadRef,
  matchYourWork,
} from "./your-work";

const buildPluginSignal = (id: string, threadRef: string): Signal => ({
  id,
  kind: "github/review-requested",
  origin: { type: "event", eventId: 1, connectionId: "conn-1", threadRef },
  title: `Signal ${id}`,
  priority: "normal",
  blocks: [],
  actions: [],
  match: {},
  status: "open",
  createdAt: "2026-10-10T09:00:00.000Z",
});

const buildCoreSignal = (id: string): Signal => ({
  ...buildPluginSignal(id, "unused"),
  origin: { type: "api", actor: "user", eventIds: [], reason: "Test" },
});

/** Builds a Task whose provenance names each of `refs`, last updated at `updatedAt`. */
const buildTask = (
  id: string,
  refs: ReadonlyArray<string>,
  { status = "open", updatedAt = "2026-10-10T09:00:00.000Z" }: Partial<Task> = {},
): Task => ({
  id,
  title: `Task ${id}`,
  description: "",
  status,
  priority: "normal",
  labels: [],
  provenance: refs.map((ref) => ({
    ref,
    at: "2026-10-10T09:00:00.000Z",
    actor: "user",
  })),
  createdAt: "2026-10-10T09:00:00.000Z",
  updatedAt,
  statusChangedAt: "2026-10-10T09:00:00.000Z",
});

const PR_1 = "github:pr:acme/shop#1";
const PR_2 = "github:pr:acme/shop#2";

describe("batchYourWorkRefs", () => {
  it("lists each thread ref once, sorted, and skips signals without a usable ref", () => {
    const batches = batchYourWorkRefs([
      buildPluginSignal("a", PR_2),
      buildPluginSignal("b", PR_1),
      buildPluginSignal("c", PR_2),
      buildPluginSignal("d", "not an external ref"),
      buildCoreSignal("e"),
    ]);
    expect(batches).toEqual([[PR_1, PR_2]]);
  });

  it("returns no batches when no signal has a thread ref", () => {
    expect(batchYourWorkRefs([])).toEqual([]);
    expect(batchYourWorkRefs([buildCoreSignal("a")])).toEqual([]);
  });

  it("splits the refs into batches the refs filter accepts, whatever order the signals come in", () => {
    const signals = Array.from({ length: MAX_FILTER_VALUES + 1 }, (_, index) =>
      buildPluginSignal(`s${index}`, `github:pr:acme/shop#${String(index).padStart(3, "0")}`),
    );
    const batches = batchYourWorkRefs(signals);
    expect(batches.map((batch) => batch.length)).toEqual([MAX_FILTER_VALUES, 1]);
    expect(batchYourWorkRefs(signals.toReversed())).toEqual(batches);
  });
});

describe("listSignalsWithThreadRef", () => {
  it("keeps the signals Your work can be found by, in order", () => {
    const signals = [
      buildPluginSignal("a", PR_1),
      buildCoreSignal("b"),
      buildPluginSignal("c", "not an external ref"),
      buildPluginSignal("d", PR_2),
    ];
    expect(listSignalsWithThreadRef(signals).map((signal) => signal.id)).toEqual(["a", "d"]);
  });
});

describe("isYourWorkReadOutdated", () => {
  const read = { tasks: [], refs: [PR_1, PR_2] };

  it("is false while the signals have the refs the read was made for, in any order or number", () => {
    expect(
      isYourWorkReadOutdated(read, [
        buildPluginSignal("a", PR_2),
        buildPluginSignal("b", PR_1),
        buildPluginSignal("c", PR_1),
        buildCoreSignal("d"),
      ]),
    ).toBe(false);
  });

  it("is true when a ref came or went", () => {
    expect(isYourWorkReadOutdated(read, [buildPluginSignal("a", PR_1)])).toBe(true);
    expect(
      isYourWorkReadOutdated(read, [
        buildPluginSignal("a", PR_1),
        buildPluginSignal("b", PR_2),
        buildPluginSignal("c", "github:pr:acme/shop#3"),
      ]),
    ).toBe(true);
  });

  it("is false when there is no read yet, because that read will find the signals itself", () => {
    expect(isYourWorkReadOutdated(undefined, [buildPluginSignal("a", PR_1)])).toBe(false);
  });
});

describe("matchYourWork", () => {
  it("gives a signal the open Tasks whose provenance names its thread ref", () => {
    const yourWork = matchYourWork(
      [buildPluginSignal("a", PR_1), buildPluginSignal("b", PR_2)],
      [buildTask("t1", [PR_1]), buildTask("t2", ["github:issue:acme/shop#9", PR_1])],
    );
    expect(yourWork.get("a")?.map((task) => task.id)).toEqual(["t1", "t2"]);
    expect(yourWork.has("b")).toBe(false);
  });

  it("counts a Task once when two batches both returned it", () => {
    const task = buildTask("t1", [PR_1, PR_2]);
    const yourWork = matchYourWork([buildPluginSignal("a", PR_1)], [task, task]);
    expect(yourWork.get("a")).toEqual([task]);
  });

  it("never matches a done or cancelled Task, and counts in-progress as open", () => {
    const yourWork = matchYourWork(
      [buildPluginSignal("a", PR_1)],
      [
        buildTask("done", [PR_1], { status: "done" }),
        buildTask("cancelled", [PR_1], { status: "cancelled" }),
        buildTask("working", [PR_1], { status: "in-progress" }),
      ],
    );
    expect(yourWork.get("a")?.map((task) => task.id)).toEqual(["working"]);
  });

  it("orders a signal's Tasks by most recent update, then id", () => {
    const yourWork = matchYourWork(
      [buildPluginSignal("a", PR_1)],
      [
        buildTask("b", [PR_1], { updatedAt: "2026-10-10T10:00:00.000Z" }),
        buildTask("new", [PR_1], { updatedAt: "2026-10-10T11:00:00.000Z" }),
        buildTask("a", [PR_1], { updatedAt: "2026-10-10T10:00:00.000Z" }),
      ],
    );
    expect(yourWork.get("a")?.map((task) => task.id)).toEqual(["new", "a", "b"]);
  });

  it("gives one Task to every signal on its thread, and nothing to a core signal", () => {
    const task = buildTask("t1", [PR_1]);
    const yourWork = matchYourWork(
      [buildPluginSignal("a", PR_1), buildPluginSignal("b", PR_1), buildCoreSignal("c")],
      [task],
    );
    expect([...yourWork.keys()]).toEqual(["a", "b"]);
    expect(yourWork.get("b")).toEqual([task]);
  });
});
