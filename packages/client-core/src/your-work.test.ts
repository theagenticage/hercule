/** Tests how Your work is read for the signals on screen and matched back to them. */
import { MAX_FILTER_VALUES, type Signal, type Task } from "@hercule/contract";
import { describe, expect, it } from "vitest";
import { createClient } from "./client";
import {
  batchYourWorkRefs,
  isYourWorkReadOutdated,
  listSignalsWithThreadRef,
  listYourWorkRefs,
  matchYourWork,
  buildYourWorkTask,
  type YourWorkTask,
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

/** Builds the slim Task whose provenance names each of `refs`, last updated at `updatedAt`. */
const buildTask = (
  id: string,
  refs: ReadonlyArray<string>,
  { status = "open", updatedAt = "2026-10-10T09:00:00.000Z" }: Partial<Task> = {},
): YourWorkTask =>
  buildYourWorkTask({
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

describe("listYourWorkRefs", () => {
  it("lists each thread ref once, sorted, and skips signals without a usable ref", () => {
    expect(
      listYourWorkRefs([
        buildPluginSignal("a", PR_2),
        buildPluginSignal("b", PR_1),
        buildPluginSignal("c", PR_2),
        buildPluginSignal("d", "not an external ref"),
        buildCoreSignal("e"),
      ]),
    ).toEqual([PR_1, PR_2]);
  });
});

describe("buildYourWorkTask", () => {
  it("keeps what Your work uses, and only the provenance entries that have a ref", () => {
    const slim = buildYourWorkTask({
      id: "t1",
      title: "Fix it",
      description: "x".repeat(1000),
      status: "in-progress",
      priority: "normal",
      labels: [],
      provenance: [
        { ref: PR_1, at: "2026-10-10T09:00:00.000Z", actor: "user" },
        { runId: "run-1", at: "2026-10-10T09:00:00.000Z", actor: "user" },
      ],
      createdAt: "2026-10-10T08:00:00.000Z",
      updatedAt: "2026-10-10T09:00:00.000Z",
      statusChangedAt: "2026-10-10T08:00:00.000Z",
    });
    expect(slim).toEqual({
      id: "t1",
      title: "Fix it",
      status: "in-progress",
      updatedAt: "2026-10-10T09:00:00.000Z",
      provenanceRefs: [PR_1],
    });
  });
});

describe("batchYourWorkRefs", () => {
  it("returns no batches for no refs", () => {
    expect(batchYourWorkRefs([])).toEqual([]);
  });

  it("keeps short refs in order, and splits them at the refs filter's limit", () => {
    const refs = Array.from(
      { length: MAX_FILTER_VALUES + 1 },
      (_, index) => `github:pr:acme/shop#${String(index).padStart(3, "0")}`,
    );
    expect(batchYourWorkRefs(refs).map((batch) => batch.length)).toEqual([MAX_FILTER_VALUES, 1]);
    expect(batchYourWorkRefs(refs).flat()).toEqual(refs);
  });

  it("splits long refs so a request's query string stays small", () => {
    const refs = Array.from(
      { length: MAX_FILTER_VALUES },
      (_, index) => `github:pr:acme/${String(index).padStart(3, "0")}${"x".repeat(500)}#1`,
    );
    const batches = batchYourWorkRefs(refs);
    expect(batches.length).toBeGreaterThan(1);
    expect(batches.flat()).toEqual(refs);
    for (const batch of batches) {
      const query = batch.map((ref) => `refs=${encodeURIComponent(ref)}`).join("&");
      expect(query.length).toBeLessThanOrEqual(8 * 1024);
    }
  });

  it("measures refs as the client writes them, so characters it escapes still fit in the request", async () => {
    // The client writes the query with URLSearchParams, which escapes "~" and "'" where
    // encodeURIComponent leaves them as they are.
    const refs = Array.from(
      { length: MAX_FILTER_VALUES },
      (_, index) => `external:thread:${"~'".repeat(240)}${String(index).padStart(3, "0")}`,
    );
    const batches = batchYourWorkRefs(refs);
    expect(batches.flat()).toEqual(refs);

    const requests: Array<string> = [];
    const client = createClient({
      baseUrl: "http://controller.test",
      fetch: (url) => {
        requests.push(String(url));
        return Promise.resolve(
          new Response(JSON.stringify({ items: [] }), {
            headers: { "content-type": "application/json" },
          }),
        );
      },
    });
    for (const batch of batches) await client.task.query({ query: { refs: batch } });

    expect(requests).toHaveLength(batches.length);
    for (const request of requests) {
      const refsQuery = new URL(request).search
        .slice(1)
        .split("&")
        .filter((parameter) => parameter.startsWith("refs="))
        .join("&");
      expect(refsQuery.length).toBeLessThanOrEqual(8 * 1024);
    }
  });

  it("sends a ref that is over the limit by itself in a batch of its own", () => {
    const huge = `github:pr:acme/${"y".repeat(9000)}#1`;
    expect(batchYourWorkRefs([PR_1, huge, PR_2])).toEqual([[PR_1], [huge], [PR_2]]);
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
});

describe("matchYourWork", () => {
  const taskIds = (yourWork: ReturnType<typeof matchYourWork>, signalId: string) =>
    yourWork.get(signalId)?.tasks.map((task) => task.id);

  it("gives a signal the Tasks whose provenance names its thread ref, with the signal", () => {
    const signal = buildPluginSignal("a", PR_1);
    const yourWork = matchYourWork(
      [signal, buildPluginSignal("b", PR_2)],
      [buildTask("t1", [PR_1]), buildTask("t2", ["github:issue:acme/shop#9", PR_1])],
    );
    expect(taskIds(yourWork, "a")).toEqual(["t1", "t2"]);
    expect(yourWork.get("a")?.signal).toBe(signal);
    expect(yourWork.has("b")).toBe(false);
  });

  it("counts a Task once when two batches both returned it", () => {
    const task = buildTask("t1", [PR_1, PR_2]);
    expect(taskIds(matchYourWork([buildPluginSignal("a", PR_1)], [task, task]), "a")).toEqual([
      "t1",
    ]);
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
    expect(taskIds(yourWork, "a")).toEqual(["new", "a", "b"]);
  });

  it("gives one Task to every signal on its thread, and nothing to a core signal", () => {
    const task = buildTask("t1", [PR_1]);
    const yourWork = matchYourWork(
      [buildPluginSignal("a", PR_1), buildPluginSignal("b", PR_1), buildCoreSignal("c")],
      [task],
    );
    expect([...yourWork.keys()]).toEqual(["a", "b"]);
    expect(yourWork.get("b")?.tasks).toEqual([task]);
  });
});
