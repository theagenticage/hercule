import { describe, expect, it } from "vitest";
import type { InboxGroup } from "@hercule/contract";
import {
  createInboxVisit,
  type FirstPage,
  type InboxReader,
  type InboxVisit,
  type MoveReceipt,
  type NextPage,
} from "./inbox-visit";

interface Row {
  readonly ref: string;
  readonly title: string;
  readonly arrival: number;
}
const row = (ref: string, title = ref, arrival = 0): Row => ({ ref, title, arrival });
const rows = (...refs: string[]) => refs.map((ref) => row(ref));

/** One read the visit made, answered by the test when it chooses to. */
interface Call {
  readonly kind: "first" | "next" | "refresh" | "rows";
  readonly query: string;
  readonly after?: string;
  readonly held?: readonly string[];
  readonly signal: AbortSignal;
  answered: boolean;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
}

/** A reader whose reads wait until the test answers them, so the test controls their order. */
function fakeReader() {
  const calls: Call[] = [];
  const make = <T>(
    kind: Call["kind"],
    query: string,
    signal: AbortSignal,
    extra: { after?: string; held?: readonly string[] } = {},
  ): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const call: Call = {
        kind,
        query,
        ...extra,
        signal,
        answered: false,
        resolve: (value) => {
          call.answered = true;
          resolve(value as T);
        },
        reject: (error: Error) => {
          call.answered = true;
          reject(error);
        },
      };
      calls.push(call);
    });
  // Replies may leave out the groups: a reply of things only is a reply with no group.
  type Plain<T> = Omit<T, "groups"> & { groups?: T extends { groups: infer G } ? G : never };
  const reader: InboxReader<Row, string> = {
    readFirst: (query, signal) =>
      make<Plain<FirstPage<Row>>>("first", query, signal).then((page) => ({ groups: [], ...page })),
    readNext: (query, after, signal) =>
      make<Plain<NextPage<Row>>>("next", query, signal, { after }).then((page) => ({
        groups: [],
        ...page,
      })),
    refresh: (query, held, signal) =>
      make<{
        firstPage: Plain<FirstPage<Row>>;
        heldRows: readonly Row[];
        heldGroups?: readonly InboxGroup[];
      }>("refresh", query, signal, { held }).then((reply) => ({
        heldGroups: [],
        ...reply,
        firstPage: { groups: [], ...reply.firstPage },
      })),
    readRows: (query, held, signal) =>
      make<readonly Row[] | { rows: readonly Row[]; groups: readonly InboxGroup[] }>(
        "rows",
        query,
        signal,
        { held },
      ).then((reply) => ("rows" in reply ? reply : { rows: reply, groups: [] })),
  };
  return {
    reader,
    calls,
    /** The newest read of `kind` that nobody answered yet. */
    open: (kind: Call["kind"]): Call => {
      const call = calls.findLast((c) => c.kind === kind && !c.answered);
      if (call === undefined) throw new Error(`no open ${kind} read`);
      return call;
    },
    count: (kind: Call["kind"]) => calls.filter((c) => c.kind === kind).length,
  };
}
type Fake = ReturnType<typeof fakeReader>;

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

const firstPage = (items: Row[], more = false): FirstPage<Row> => ({
  rows: items,
  groups: [],
  nextCursor: more ? "cursor" : undefined,
  total: items.length,
  order: "waiting",
});

async function answerFirst(fake: Fake, items: Row[], more = false): Promise<void> {
  fake.open("first").resolve(firstPage(items, more));
  await settle();
}

/** Answers the open refresh as the controller would: the first page, and the held rows still in. */
async function answerRefresh(
  fake: Fake,
  items: Row[],
  { stillIn = [], more = false }: { stillIn?: Row[]; more?: boolean } = {},
): Promise<void> {
  fake.open("refresh").resolve({ firstPage: firstPage(items, more), heldRows: stillIn });
  await settle();
}

async function opened(items: Row[], more = false) {
  const fake = fakeReader();
  const visit = createInboxVisit(fake.reader);
  visit.open("list-1");
  await answerFirst(fake, items, more);
  return { fake, visit };
}

const refsOf = (visit: InboxVisit<Row, string>) => visit.getSnapshot().rows.map((r) => r.ref);

/** Confirms a move the way the screen does when the controller answers. */
const confirmed = (visit: InboxVisit<Row, string>, receipt: MoveReceipt<Row>) => {
  visit.confirmMove(receipt);
  return receipt;
};

describe("opening a list", () => {
  it("is loading until the first page arrives, then ready with the first row current", async () => {
    const fake = fakeReader();
    const visit = createInboxVisit(fake.reader);
    expect(visit.getSnapshot().status).toBe("loading");
    visit.open("list-1");
    expect(visit.getSnapshot().status).toBe("loading");
    await answerFirst(fake, rows("a", "b"));
    const snapshot = visit.getSnapshot();
    expect(snapshot.status).toBe("ready");
    expect(snapshot.query).toBe("list-1");
    expect(snapshot.rows.map((r) => r.ref)).toEqual(["a", "b"]);
    expect(snapshot.current).toBe("a");
    expect(snapshot.total).toBe(2);
    expect(snapshot.order).toBe("waiting");
  });

  it("keeps the previous list on screen until the next list's first page arrives", async () => {
    const { fake, visit } = await opened(rows("a", "b"));
    visit.open("list-2");
    expect(visit.getSnapshot().status).toBe("ready");
    expect(visit.getSnapshot().query).toBe("list-1");
    expect(refsOf(visit)).toEqual(["a", "b"]);
    await answerFirst(fake, rows("x"));
    expect(visit.getSnapshot().query).toBe("list-2");
    expect(refsOf(visit)).toEqual(["x"]);
  });

  it("ignores the first page of a list the user has left since", async () => {
    const fake = fakeReader();
    const visit = createInboxVisit(fake.reader);
    visit.open("list-1");
    const stale = fake.open("first");
    visit.open("list-2");
    expect(stale.signal.aborted).toBe(true);
    stale.resolve(firstPage(rows("old")));
    await settle();
    expect(visit.getSnapshot().status).toBe("loading");
    await answerFirst(fake, rows("new"));
    expect(refsOf(visit)).toEqual(["new"]);
  });

  it("never lets a row read of the list left behind change the list that replaced it", async () => {
    const { fake, visit } = await opened(rows("x"));
    visit.pushArrived();
    visit.open("list-2");
    // The old list is still shown while the new one opens, so its viewport can start a read.
    visit.viewportChanged(0, 0);
    expect(fake.count("rows")).toBe(1);
    fake.open("first").resolve(firstPage(rows("x")));
    await settle();
    expect(fake.open("rows").signal.aborted).toBe(true);
    fake.open("rows").resolve([]);
    await settle();
    expect(visit.getSnapshot().query).toBe("list-2");
    expect(refsOf(visit)).toEqual(["x"]);
  });

  it("fails when the first page cannot be read, and reads again when opened again", async () => {
    const fake = fakeReader();
    const visit = createInboxVisit(fake.reader);
    visit.open("list-1");
    fake.open("first").reject(new Error("offline"));
    await settle();
    expect(visit.getSnapshot().status).toBe("failed");
    expect(visit.getSnapshot().error).toEqual(new Error("offline"));
    visit.open("list-1");
    expect(visit.getSnapshot().status).toBe("loading");
    await answerFirst(fake, rows("a"));
    expect(visit.getSnapshot().status).toBe("ready");
  });

  it("starts the first page again for a push that arrives during its read", async () => {
    const fake = fakeReader();
    const visit = createInboxVisit(fake.reader);
    visit.open("list-1");
    const before = fake.open("first");
    visit.pushArrived();
    expect(before.signal.aborted).toBe(true);
    expect(fake.count("first")).toBe(2);
    before.resolve(firstPage(rows("stale")));
    await settle();
    expect(visit.getSnapshot().status).toBe("loading");
    await answerFirst(fake, rows("fresh"));
    expect(refsOf(visit)).toEqual(["fresh"]);
  });

  it("closing cancels every read", async () => {
    const { fake, visit } = await opened(rows("a"), true);
    visit.pushArrived();
    visit.viewportChanged(0, 0);
    visit.close();
    expect(fake.open("refresh").signal.aborted).toBe(true);
    expect(fake.open("next").signal.aborted).toBe(true);
  });
});

describe("the snapshot", () => {
  it("is the same object until something changes, and tells subscribers when it does", async () => {
    const { visit } = await opened(rows("a", "b"));
    const first = visit.getSnapshot();
    expect(visit.getSnapshot()).toBe(first);
    let told = 0;
    const stop = visit.subscribe(() => (told += 1));
    visit.select({ kind: "clear" });
    expect(told).toBe(1);
    visit.step(1);
    expect(told).toBe(2);
    expect(visit.getSnapshot()).not.toBe(first);
    stop();
    visit.step(1);
    expect(told).toBe(2);
  });

  it("does not change for a selection change that changes nothing", async () => {
    const { visit } = await opened(rows("a"));
    const before = visit.getSnapshot();
    visit.select({ kind: "toggle", ref: "ghost" });
    expect(visit.getSnapshot()).toBe(before);
  });
});

describe("a refresh", () => {
  it("asks about the held rows and applies one reply: in place, no re-sorting", async () => {
    const { fake, visit } = await opened(rows("a", "b", "c"));
    visit.pushArrived();
    expect(fake.open("refresh").held).toEqual(["a", "b", "c"]);
    await answerRefresh(fake, [row("c"), row("b", "new title"), row("a")]);
    expect(refsOf(visit)).toEqual(["a", "b", "c"]);
    expect(visit.getSnapshot().rows[1]!.title).toBe("new title");
    expect(visit.getSnapshot().arrivals).toBe(0);
  });

  it("keeps the row objects and the snapshot when a refresh brings equal copies", async () => {
    const { fake, visit } = await opened(rows("a", "b", "c"));
    const before = visit.getSnapshot();
    let notified = 0;
    visit.subscribe(() => (notified += 1));
    visit.pushArrived();
    await answerRefresh(fake, [row("a"), row("b"), row("c")]);
    expect(visit.getSnapshot()).toBe(before);
    expect(notified).toBe(0);
  });

  it("gives a new object only to the rows whose content changed", async () => {
    const { fake, visit } = await opened(rows("a", "b", "c"));
    const [a, b, c] = visit.getSnapshot().rows;
    visit.pushArrived();
    await answerRefresh(fake, [row("a"), row("b", "new title"), row("c")]);
    const after = visit.getSnapshot().rows;
    expect(after[0]).toBe(a);
    expect(after[1]).not.toBe(b);
    expect(after[1]!.title).toBe("new title");
    expect(after[2]).toBe(c);
  });

  it("drops a held row that is in neither part of the reply, and updates one that is in the second", async () => {
    const { fake, visit } = await opened(rows("a", "b", "c", "d"));
    visit.pushArrived();
    await answerRefresh(fake, [row("a")], { stillIn: [row("c", "read by ref")] });
    expect(refsOf(visit)).toEqual(["a", "c"]);
    expect(visit.getSnapshot().rows[1]!.title).toBe("read by ref");
    expect(visit.getSnapshot().lastChange).toEqual({ kind: "left", refs: ["b", "d"] });
  });

  it("settles the current row when it leaves", async () => {
    const { fake, visit } = await opened(rows("a", "b", "c"));
    visit.step(1);
    visit.pushArrived();
    await answerRefresh(fake, rows("a", "c"));
    expect(visit.getSnapshot().current).toBe("c");
  });

  it("holds back a first-page row that is not held and counts it", async () => {
    const { fake, visit } = await opened(rows("a", "b"));
    visit.pushArrived();
    await answerRefresh(fake, rows("n", "a", "b"));
    expect(refsOf(visit)).toEqual(["a", "b"]);
    expect(visit.getSnapshot().arrivals).toBe(1);
  });

  it("applies nothing when the read fails, so a row missing from a failed read is not taken for one that left", async () => {
    const { fake, visit } = await opened(rows("a", "b"));
    const before = visit.getSnapshot();
    visit.pushArrived();
    fake.open("refresh").reject(new Error("down"));
    await settle();
    expect(visit.getSnapshot()).toBe(before);
    expect(visit.getSnapshot().status).toBe("ready");
  });

  it("is overtaken by a push during the read: the old reply is ignored and a new read starts", async () => {
    const { fake, visit } = await opened(rows("a", "b"));
    visit.pushArrived();
    const old = fake.open("refresh");
    visit.pushArrived();
    expect(old.signal.aborted).toBe(true);
    expect(fake.count("refresh")).toBe(2);
    old.resolve({ firstPage: firstPage(rows("a")), heldRows: [] });
    await settle();
    expect(refsOf(visit)).toEqual(["a", "b"]);
    await answerRefresh(fake, rows("a", "b"));
    expect(refsOf(visit)).toEqual(["a", "b"]);
  });

  it("applies the new reply when a push arrives after the read finished", async () => {
    const { fake, visit } = await opened(rows("a"));
    visit.pushArrived();
    await answerRefresh(fake, rows("a"));
    visit.pushArrived();
    await answerRefresh(fake, [row("a", "again")]);
    expect(visit.getSnapshot().rows[0]!.title).toBe("again");
  });

  it("updates the total, the order and the facets from the first page", async () => {
    const { fake, visit } = await opened(rows("a"));
    visit.pushArrived();
    fake.open("refresh").resolve({
      firstPage: { ...firstPage(rows("a")), total: 42, order: "newest" },
      heldRows: [],
    });
    await settle();
    expect(visit.getSnapshot().total).toBe(42);
    expect(visit.getSnapshot().order).toBe("newest");
  });
});

describe("the arrival watermark", () => {
  it("appends a thing that slid in from the next page quietly, but counts one ranking above held rows", async () => {
    const refs = Array.from({ length: 300 }, (_, i) => `t${i}`);
    const { fake, visit } = await opened(rows(...refs.slice(0, 200)), true);
    const receipt = visit.move("dismissed", ["t0"]);
    visit.confirmMove(receipt);
    visit.pushArrived();
    await answerRefresh(fake, rows(...refs.slice(1, 201)), { more: true });
    expect(visit.getSnapshot().arrivals).toBe(0);
    expect(refsOf(visit).at(-1)).toBe("t200");
    expect(refsOf(visit)).toHaveLength(200);
    visit.pushArrived();
    await answerRefresh(fake, rows("fresh", ...refs.slice(1, 201)), { more: true });
    expect(visit.getSnapshot().arrivals).toBe(1);
  });

  it("counts a genuine arrival that ranks after every held row, by its arrival number", async () => {
    const old = Array.from({ length: 199 }, (_, i) => row(`o${i}`, `o${i}`, i + 1));
    const { fake, visit } = await opened(old, true);
    visit.pushArrived();
    await answerRefresh(fake, [...old, row("n1", "n1", 500), row("n2", "n2", 501)], {
      more: true,
    });
    expect(visit.getSnapshot().arrivals).toBe(2);
    expect(refsOf(visit)).toHaveLength(199);
  });

  it("appends a slid-in row quietly only while its arrival is within the watermark, and Show raises it", async () => {
    const held = [row("a", "a", 5), row("b", "b", 9)];
    const { fake, visit } = await opened(held, true);
    visit.pushArrived();
    await answerRefresh(fake, [...held, row("c", "c", 7)], { more: true });
    expect(refsOf(visit)).toEqual(["a", "b", "c"]);
    visit.pushArrived();
    await answerRefresh(fake, [...held, row("c", "c", 7), row("d", "d", 10)], { more: true });
    expect(visit.getSnapshot().arrivals).toBe(1);
    visit.show();
    await answerRefresh(fake, [...held, row("c", "c", 7), row("d", "d", 10)], { more: true });
    expect(refsOf(visit)).toEqual(["a", "b", "c", "d"]);
    visit.pushArrived();
    await answerRefresh(fake, [...held, row("c", "c", 7), row("d", "d", 10), row("e", "e", 10)], {
      more: true,
    });
    expect(refsOf(visit)).toContain("e");
    expect(visit.getSnapshot().arrivals).toBe(0);
  });

  it("counts a thing ranking last as an arrival when no next page exists", async () => {
    const { fake, visit } = await opened(rows("a", "b"));
    visit.pushArrived();
    await answerRefresh(fake, rows("a", "b", "z"));
    expect(visit.getSnapshot().arrivals).toBe(1);
  });
});

describe("Show", () => {
  it("re-reads the first page first, then places arrivals where it ranks them and makes the first new row current", async () => {
    const { fake, visit } = await opened(rows("a", "b", "c"));
    visit.pushArrived();
    await answerRefresh(fake, rows("n1", "a", "b", "c"));
    visit.show();
    expect(visit.getSnapshot().arrivals).toBe(1);
    expect(fake.count("refresh")).toBe(2);
    await answerRefresh(fake, rows("n1", "a", "n2", "b", "c"));
    expect(refsOf(visit)).toEqual(["n1", "a", "n2", "b", "c"]);
    expect(visit.getSnapshot().arrivals).toBe(0);
    expect(visit.getSnapshot().current).toBe("n1");
    expect(visit.getSnapshot().lastChange).toEqual({ kind: "arrived", refs: ["n1", "n2"] });
  });

  it("chains arrivals that rank next to each other", async () => {
    const { fake, visit } = await opened(rows("a"));
    visit.pushArrived();
    await answerRefresh(fake, rows("a", "n1", "n2"));
    visit.show();
    await answerRefresh(fake, rows("a", "n1", "n2"));
    expect(refsOf(visit)).toEqual(["a", "n1", "n2"]);
    expect(visit.getSnapshot().current).toBe("n1");
  });

  it("changes nothing and reads nothing when nothing waits", async () => {
    const { fake, visit } = await opened(rows("a"));
    visit.show();
    expect(fake.count("refresh")).toBe(0);
  });

  it("takes in the arrivals already held when the read fails", async () => {
    const { fake, visit } = await opened(rows("a"));
    visit.pushArrived();
    await answerRefresh(fake, rows("n", "a"));
    visit.show();
    fake.open("refresh").reject(new Error("down"));
    await settle();
    expect(refsOf(visit)).toEqual(["n", "a"]);
  });

  it("still takes arrivals in when a push overtakes the read it waits for", async () => {
    const { fake, visit } = await opened(rows("a"));
    visit.pushArrived();
    await answerRefresh(fake, rows("n", "a"));
    visit.show();
    visit.pushArrived();
    await answerRefresh(fake, rows("n", "a", "m"));
    expect(refsOf(visit)).toEqual(["n", "a", "m"]);
    expect(visit.getSnapshot().arrivals).toBe(0);
  });
});

describe("the next page", () => {
  it("is read near the end, once, and appended without the rows already held", async () => {
    const { fake, visit } = await opened(rows("a", "b"), true);
    visit.viewportChanged(0, 1);
    visit.viewportChanged(0, 1);
    expect(fake.count("next")).toBe(1);
    expect(fake.open("next").after).toBe("cursor");
    fake.open("next").resolve({ rows: rows("b", "c"), nextCursor: "c2" });
    await settle();
    expect(refsOf(visit)).toEqual(["a", "b", "c"]);
    visit.viewportChanged(0, 2);
    expect(fake.open("next").after).toBe("c2");
  });

  it("is not read far from the end, nor when no page follows", async () => {
    const refs = Array.from({ length: 100 }, (_, i) => `t${i}`);
    const far = await opened(rows(...refs), true);
    far.visit.viewportChanged(0, 10);
    expect(far.fake.count("next")).toBe(0);
    const last = await opened(rows("a"));
    last.visit.viewportChanged(0, 0);
    expect(last.fake.count("next")).toBe(0);
  });

  it("keeps the frontier through a refresh", async () => {
    const { fake, visit } = await opened(rows("a", "b"), true);
    visit.pushArrived();
    await answerRefresh(fake, rows("a", "b"), { more: true });
    visit.viewportChanged(0, 1);
    expect(fake.open("next").after).toBe("cursor");
  });

  it("is not cancelled by a push, and its rows are read afresh later", async () => {
    const { fake, visit } = await opened(rows("a", "b"), true);
    visit.viewportChanged(0, 1);
    const next = fake.open("next");
    visit.pushArrived();
    expect(next.signal.aborted).toBe(false);
    next.resolve({ rows: rows("c") });
    await settle();
    expect(refsOf(visit)).toEqual(["a", "b", "c"]);
  });

  it("is ignored when the user switched to another list meanwhile", async () => {
    const { fake, visit } = await opened(rows("a", "b"), true);
    visit.viewportChanged(0, 1);
    const next = fake.open("next");
    visit.open("list-2");
    expect(next.signal.aborted).toBe(true);
    next.resolve({ rows: rows("late") });
    await settle();
    expect(refsOf(visit)).toEqual(["a", "b"]);
    await answerFirst(fake, rows("x"));
    expect(refsOf(visit)).toEqual(["x"]);
  });

  it("lets a failed page be read again the next time the end is near", async () => {
    const { fake, visit } = await opened(rows("a"), true);
    visit.viewportChanged(0, 0);
    fake.open("next").reject(new Error("down"));
    await settle();
    visit.viewportChanged(0, 0);
    expect(fake.count("next")).toBe(2);
  });
});

describe("freshness against the pushes", () => {
  const many = (n: number) => Array.from({ length: n }, (_, i) => `t${i}`);

  it("asks a refresh about at most 400 held rows around the viewport", async () => {
    const { fake, visit } = await opened(rows(...many(1000)));
    visit.viewportChanged(700, 720);
    visit.pushArrived();
    const held = fake.open("refresh").held!;
    expect(held).toHaveLength(400);
    expect(held).toContain("t700");
    expect(held).toContain("t720");
    expect(held).not.toContain("t0");
    expect(held).not.toContain("t999");
  });

  it("leaves rows far off-screen as they were, and re-reads them when they scroll into view", async () => {
    const { fake, visit } = await opened(rows(...many(1000)));
    visit.pushArrived();
    // The window is the top 400: t900 is not asked about and keeps its old copy.
    await answerRefresh(fake, [row("t0", "t0 new")], {
      stillIn: rows(...many(400).slice(1)),
    });
    expect(visit.getSnapshot().rows[900]!.title).toBe("t900");
    expect(fake.count("rows")).toBe(0);
    visit.viewportChanged(895, 910);
    const read = fake.open("rows");
    expect(read.held).toContain("t900");
    expect(read.held).not.toContain("t0");
    read.resolve(read.held!.map((ref) => (ref === "t900" ? row(ref, "t900 new") : row(ref))));
    await settle();
    expect(visit.getSnapshot().rows[900]!.title).toBe("t900 new");
    // Fresh now: scrolling there again reads nothing.
    visit.viewportChanged(896, 911);
    expect(fake.count("rows")).toBe(1);
  });

  it("drops a row that left the list while it was off-screen when it is re-read", async () => {
    const { fake, visit } = await opened(rows(...many(1000)));
    visit.pushArrived();
    await answerRefresh(fake, [row("t0")], { stillIn: rows(...many(400).slice(1)) });
    visit.viewportChanged(895, 910);
    const read = fake.open("rows");
    read.resolve(rows(...read.held!.filter((ref) => ref !== "t900")));
    await settle();
    expect(refsOf(visit)).not.toContain("t900");
    expect(visit.getSnapshot().lastChange).toEqual({ kind: "left", refs: ["t900"] });
  });

  it("does not read rows a refresh in flight already covers", async () => {
    const { fake, visit } = await opened(rows(...many(10)));
    visit.pushArrived();
    visit.viewportChanged(0, 5);
    expect(fake.count("rows")).toBe(0);
  });

  it("cancels a row read when a push arrives, and covers its rows by the new refresh", async () => {
    const { fake, visit } = await opened(rows(...many(1000)));
    visit.pushArrived();
    await answerRefresh(fake, [row("t0")], { stillIn: rows(...many(400).slice(1)) });
    visit.viewportChanged(895, 910);
    const read = fake.open("rows");
    visit.pushArrived();
    expect(read.signal.aborted).toBe(true);
    read.resolve([row("t900", "stale answer")]);
    await settle();
    expect(visit.getSnapshot().rows[900]!.title).toBe("t900");
  });
});

describe("moves", () => {
  it("dismissing removes the rows at once and makes the next row current", async () => {
    const { visit } = await opened(rows("a", "b", "c"));
    visit.move("dismissed", ["a"]);
    expect(refsOf(visit)).toEqual(["b", "c"]);
    expect(visit.getSnapshot().current).toBe("b");
    expect(visit.getSnapshot().lastChange).toEqual({ kind: "dismissed", refs: ["a"] });
  });

  it("skips next rows that leave too, in the old order", async () => {
    const { visit } = await opened(rows("a", "b", "c", "d"));
    visit.step(1);
    visit.move("dismissed", ["b", "c"]);
    expect(visit.getSnapshot().current).toBe("d");
  });

  it("falls back to the previous row after the last one, and to none when empty, which says so", async () => {
    const { visit } = await opened(rows("a", "b"));
    visit.step(1);
    visit.move("dismissed", ["b"]);
    expect(visit.getSnapshot().current).toBe("a");
    visit.move("dismissed", ["a"]);
    expect(visit.getSnapshot().current).toBeNull();
    expect(visit.getSnapshot().lastChange).toEqual({ kind: "emptied-by-move", refs: ["a"] });
  });

  it("prunes the selection to the displayed rows", async () => {
    const { visit } = await opened(rows("a", "b", "c"));
    visit.select({ kind: "all" });
    visit.move("dismissed", ["b"]);
    expect([...visit.getSnapshot().selection]).toEqual(["a", "c"]);
  });

  it("ignores refs the list does not hold", async () => {
    const { visit } = await opened(rows("a"));
    const receipt = visit.move("dismissed", ["ghost"]);
    expect(receipt.refs).toEqual([]);
    expect(refsOf(visit)).toEqual(["a"]);
  });

  describe("a dismissal that is still on its way", () => {
    it("is not undone by a refresh that still has the row", async () => {
      const { fake, visit } = await opened(rows("a", "b"));
      visit.move("dismissed", ["a"]);
      visit.pushArrived();
      await answerRefresh(fake, rows("a", "b"));
      expect(refsOf(visit)).toEqual(["b"]);
      expect(visit.getSnapshot().arrivals).toBe(0);
    });

    it("is not confirmed by a read issued before the controller confirmed the move", async () => {
      const { fake, visit } = await opened(rows("a", "b"));
      const receipt = visit.move("dismissed", ["a"]);
      visit.pushArrived();
      const early = fake.open("refresh");
      visit.confirmMove(receipt);
      // The early read was issued before the confirmation. It ran against a controller that may
      // not have dropped "a" yet. A push cancelled it; its late answer is ignored.
      early.resolve({ firstPage: firstPage(rows("a", "b")), heldRows: [] });
      await settle();
      expect(refsOf(visit)).toEqual(["b"]);
      expect(visit.getSnapshot().arrivals).toBe(0);
    });

    it("asks about the hidden row too, and lets a row that came back wait behind N new", async () => {
      const { fake, visit } = await opened(rows("a", "b"));
      confirmed(visit, visit.move("dismissed", ["a"]));
      visit.pushArrived();
      expect(fake.open("refresh").held).toContain("a");
      await answerRefresh(fake, rows("b"));
      visit.pushArrived();
      await answerRefresh(fake, rows("a", "b"));
      expect(refsOf(visit)).toEqual(["b"]);
      expect(visit.getSnapshot().arrivals).toBe(1);
    });

    it("keeps a row hidden that sits on a later page, and lets the next page carry it once it came back", async () => {
      const { fake, visit } = await opened(rows("a", "b"), true);
      confirmed(visit, visit.move("dismissed", ["a"]));
      visit.pushArrived();
      await answerRefresh(fake, rows("b"), { more: true });
      visit.viewportChanged(0, 0);
      fake.open("next").resolve({ rows: rows("a", "c") });
      await settle();
      expect(refsOf(visit)).toEqual(["b", "a", "c"]);
    });

    it("does not let a next page bring the row back before the dismissal was confirmed", async () => {
      const { fake, visit } = await opened(rows("a", "b"), true);
      visit.move("dismissed", ["a"]);
      visit.viewportChanged(0, 0);
      fake.open("next").resolve({ rows: rows("a", "c") });
      await settle();
      expect(refsOf(visit)).toEqual(["b", "c"]);
    });
  });

  describe("a failed move", () => {
    it("puts the rows back at their old places and makes the first current", async () => {
      const { visit } = await opened(rows("a", "b", "c", "d"));
      const receipt = visit.move("dismissed", ["b", "c"]);
      visit.failMove(receipt);
      expect(refsOf(visit)).toEqual(["a", "b", "c", "d"]);
      expect(visit.getSnapshot().current).toBe("b");
      expect(visit.getSnapshot().lastChange).toEqual({ kind: "restored", refs: ["b", "c"] });
    });
  });

  describe("a move that fails after a later move handled the same row", () => {
    it("leaves the later dismissal alone", async () => {
      const { visit } = await opened(rows("a", "b", "c"));
      const taken = visit.move("taken", ["a"]);
      visit.move("dismissed", ["a"]);
      visit.failMove(taken);
      expect(refsOf(visit)).toEqual(["b", "c"]);
    });

    it("still reverses the rows the later move did not handle", async () => {
      const { visit } = await opened(rows("a", "b", "c"));
      const taken = visit.move("taken", ["a", "b"]);
      visit.move("dismissed", ["a"]);
      visit.failMove(taken);
      expect(refsOf(visit)).toEqual(["b", "c"]);
      expect(visit.getSnapshot().current).toBe("b");
    });

    it("owns the row again once the later move was undone", async () => {
      const { visit } = await opened(rows("a", "b"));
      const taken = visit.move("taken", ["a"]);
      const dismissed = visit.move("dismissed", ["a"]);
      visit.undo(dismissed);
      visit.failMove(taken);
      expect(refsOf(visit)).toEqual(["a", "b"]);
      expect(visit.getSnapshot().current).toBe("a");
    });
  });

  describe("undo", () => {
    it("restores rows at their old index and makes the first current, even after a refresh", async () => {
      const { fake, visit } = await opened(rows("a", "b", "c", "d"));
      const receipt = confirmed(visit, visit.move("dismissed", ["b", "c"]));
      visit.pushArrived();
      await answerRefresh(fake, rows("a", "d"));
      visit.undo(receipt);
      expect(refsOf(visit)).toEqual(["a", "b", "c", "d"]);
      expect(visit.getSnapshot().current).toBe("b");
    });

    it("is not undone by a refresh that was read before the undo", async () => {
      const { fake, visit } = await opened(rows("a", "b"));
      const receipt = confirmed(visit, visit.move("dismissed", ["a"]));
      visit.pushArrived();
      const early = fake.open("refresh");
      visit.undo(receipt);
      early.resolve({ firstPage: firstPage(rows("b")), heldRows: [] });
      await settle();
      expect(refsOf(visit)).toEqual(["a", "b"]);
      visit.pushArrived();
      await answerRefresh(fake, rows("a", "b"));
      expect(refsOf(visit)).toEqual(["a", "b"]);
    });

    it("lets a read issued after the undo take the row out again if the controller has it gone", async () => {
      const { fake, visit } = await opened(rows("a", "b"));
      const receipt = confirmed(visit, visit.move("dismissed", ["a"]));
      visit.undo(receipt);
      visit.pushArrived();
      await answerRefresh(fake, rows("b"));
      expect(refsOf(visit)).toEqual(["b"]);
    });

    it("puts back a taken-on row that a refresh dropped, current", async () => {
      const { fake, visit } = await opened(rows("a", "b"));
      const receipt = visit.move("taken", ["a"]);
      visit.pushArrived();
      await answerRefresh(fake, rows("b"));
      expect(refsOf(visit)).toEqual(["b"]);
      visit.undo(receipt);
      expect(refsOf(visit)).toEqual(["a", "b"]);
      expect(visit.getSnapshot().current).toBe("a");
    });

    it("promotes a row that came back behind N new before Show, never duplicating it", async () => {
      const { fake, visit } = await opened(rows("a", "b", "c"));
      const receipt = confirmed(visit, visit.move("dismissed", ["a"]));
      visit.pushArrived();
      await answerRefresh(fake, rows("b", "c"));
      visit.pushArrived();
      await answerRefresh(fake, [row("a", "a again"), ...rows("b", "c")]);
      expect(visit.getSnapshot().arrivals).toBe(1);
      visit.undo(receipt);
      expect(refsOf(visit)).toEqual(["a", "b", "c"]);
      expect(visit.getSnapshot().rows[0]!.title).toBe("a again");
      expect(visit.getSnapshot().arrivals).toBe(0);
      expect(visit.getSnapshot().current).toBe("a");
    });

    it("never duplicates a row that came back as an arrival and was shown", async () => {
      const { fake, visit } = await opened(rows("a", "b"));
      const receipt = confirmed(visit, visit.move("dismissed", ["a"]));
      visit.pushArrived();
      await answerRefresh(fake, rows("b"));
      visit.pushArrived();
      await answerRefresh(fake, rows("a", "b"));
      visit.show();
      await answerRefresh(fake, rows("a", "b"));
      visit.undo(receipt);
      expect(refsOf(visit)).toEqual(["a", "b"]);
    });

    it("restores the row when the user comes back to the same list and undoes there", async () => {
      const { fake, visit } = await opened(rows("a", "b"));
      const receipt = confirmed(visit, visit.move("dismissed", ["a"]));
      visit.open("list-2");
      await answerFirst(fake, rows("x"));
      visit.open("list-1");
      await answerFirst(fake, rows("b"));
      visit.undo(receipt);
      expect(refsOf(visit)).toEqual(["a", "b"]);
      expect(visit.getSnapshot().current).toBe("a");
      expect(visit.getSnapshot().lastChange).toEqual({ kind: "restored", refs: ["a"] });
    });

    it("does nothing for a receipt of another visit", async () => {
      const { fake, visit } = await opened(rows("a", "b"));
      const receipt = visit.move("dismissed", ["a"]);
      visit.open("list-2");
      await answerFirst(fake, rows("x", "y"));
      const before = visit.getSnapshot();
      visit.undo(receipt);
      visit.failMove(receipt);
      expect(visit.getSnapshot()).toBe(before);
    });
  });

  describe("own moves on a list of more than 200", () => {
    it("never counts the rows that slide into the first page as arrivals while moves are pending and after", async () => {
      const refs = Array.from({ length: 450 }, (_, i) => `t${i}`);
      const { fake, visit } = await opened(rows(...refs.slice(0, 200)), true);
      const receipt = visit.move("dismissed", refs.slice(0, 30));
      visit.confirmMove(receipt);
      visit.pushArrived();
      await answerRefresh(fake, rows(...refs.slice(30, 230)), { more: true });
      expect(visit.getSnapshot().arrivals).toBe(0);
      expect(refsOf(visit)).toEqual(refs.slice(30, 230));
      // The dismissed rows are gone for good: a later refresh need not hide anything.
      visit.pushArrived();
      expect(fake.open("refresh").held).not.toContain("t0");
    });
  });

  describe("a move that leaves the rows on the list (take on, hand-off)", () => {
    it("keeps the row, moves current on, prunes the selection", async () => {
      const { visit } = await opened(rows("a", "b", "c"));
      visit.select({ kind: "toggle", ref: "a" });
      visit.move("taken", ["a"]);
      expect(refsOf(visit)).toEqual(["a", "b", "c"]);
      expect(visit.getSnapshot().current).toBe("b");
      expect(visit.getSnapshot().selection.size).toBe(0);
      expect(visit.getSnapshot().anchor).toBeNull();
      expect(visit.getSnapshot().lastChange).toEqual({ kind: "taken", refs: ["a"] });
    });

    it("updates the row in place on the next refresh, or drops it", async () => {
      const { fake, visit } = await opened(rows("a", "b"));
      visit.move("taken", ["a"]);
      visit.pushArrived();
      await answerRefresh(fake, [row("a", "still asks"), row("b")]);
      expect(visit.getSnapshot().rows[0]!.title).toBe("still asks");
      visit.pushArrived();
      await answerRefresh(fake, rows("b"));
      expect(refsOf(visit)).toEqual(["b"]);
    });

    it("keeps current when every row was handled", async () => {
      const { visit } = await opened(rows("a"));
      visit.move("taken", ["a"]);
      expect(visit.getSnapshot().current).toBe("a");
    });

    it("draws a handed row as its hand-off copy until a read brings a new copy", async () => {
      const { fake, visit } = await opened(rows("a", "b"));
      visit.move("taken", ["a"], (r) => ({ ...r, title: "with a workflow" }));
      expect(visit.getSnapshot().rows[0]!.title).toBe("with a workflow");
      expect(visit.getSnapshot().rows[1]!.title).toBe("b");
      visit.pushArrived();
      await answerRefresh(fake, [row("a", "new copy"), row("b")]);
      expect(visit.getSnapshot().rows[0]!.title).toBe("new copy");
    });

    it("puts a handed row back when the hand-off fails or is taken back", async () => {
      const { visit } = await opened(rows("a", "b"));
      const show = (r: Row): Row => ({ ...r, title: "with a workflow" });
      visit.failMove(visit.move("taken", ["a"], show));
      expect(visit.getSnapshot().rows[0]!.title).toBe("a");
      visit.undo(visit.move("taken", ["a"], show));
      expect(visit.getSnapshot().rows[0]!.title).toBe("a");
      expect(visit.getSnapshot().current).toBe("a");
    });
  });
});

describe("selection and current row", () => {
  it("toggles a row and makes it the anchor", async () => {
    const { visit } = await opened(rows("a", "b"));
    visit.select({ kind: "toggle", ref: "b" });
    expect([...visit.getSnapshot().selection]).toEqual(["b"]);
    expect(visit.getSnapshot().anchor).toBe("b");
    visit.select({ kind: "toggle", ref: "b" });
    expect(visit.getSnapshot().selection.size).toBe(0);
  });

  it("extends a range with shift-J and shrinks it with shift-K, and a plain step forgets the anchor", async () => {
    const { visit } = await opened(rows("a", "b", "c", "d"));
    visit.step(1, true);
    visit.step(1, true);
    expect([...visit.getSnapshot().selection]).toEqual(["a", "b", "c"]);
    visit.step(-1, true);
    expect([...visit.getSnapshot().selection]).toEqual(["a", "b"]);
    visit.step(1);
    expect(visit.getSnapshot().anchor).toBeNull();
  });

  it("stays on the end row for a step past either end", async () => {
    const { visit } = await opened(rows("a", "b"));
    visit.step(-1);
    expect(visit.getSnapshot().current).toBe("a");
    visit.step(1);
    visit.step(1);
    expect(visit.getSnapshot().current).toBe("b");
  });

  it("selects a range by shift-click from the anchor", async () => {
    const { visit } = await opened(rows("a", "b", "c", "d"));
    visit.select({ kind: "toggle", ref: "d" });
    visit.select({ kind: "extendTo", ref: "b" });
    expect([...visit.getSnapshot().selection].sort()).toEqual(["b", "c", "d"]);
  });

  it("focuses a row on a click, selects every row and clears on Esc", async () => {
    const { visit } = await opened(rows("a", "b", "c"));
    visit.select({ kind: "focus", ref: "c" });
    expect(visit.getSnapshot().current).toBe("c");
    visit.select({ kind: "all" });
    expect(visit.getSnapshot().selection.size).toBe(3);
    visit.select({ kind: "clear" });
    expect(visit.getSnapshot().selection.size).toBe(0);
  });

  it("forgets the anchor when its row leaves", async () => {
    const { visit } = await opened(rows("a", "b"));
    visit.select({ kind: "toggle", ref: "b" });
    visit.move("dismissed", ["b"]);
    expect(visit.getSnapshot().anchor).toBeNull();
  });
});

describe("what a move acts on", () => {
  it("from the keyboard: the current row, or the selection when there is one", async () => {
    const { visit } = await opened(rows("a", "b", "c"));
    expect(visit.targets()).toEqual({ kind: "thing", row: row("a") });
    visit.select({ kind: "toggle", ref: "c" });
    visit.select({ kind: "toggle", ref: "a" });
    expect(visit.targets()).toEqual({ kind: "selection", rows: [row("a"), row("c")] });
  });

  it("from a hover button: that row, unless it is selected, then the selection", async () => {
    const { visit } = await opened(rows("a", "b", "c"));
    visit.select({ kind: "toggle", ref: "a" });
    visit.select({ kind: "toggle", ref: "b" });
    expect(visit.targets("c")).toEqual({ kind: "thing", row: row("c") });
    expect(visit.targets("b")).toEqual({ kind: "selection", rows: [row("a"), row("b")] });
  });

  it("is nothing for an empty list", async () => {
    const { visit } = await opened([]);
    expect(visit.targets()).toBeNull();
  });
});

describe("groups", () => {
  /** A group of linked things: `matching` answer the query, `quiet` do not. */
  const group = (labelRef: string, matching: string[], quiet: string[] = []): InboxGroup => ({
    labelRef,
    label: `Group ${labelRef}`,
    members: [
      ...matching.map((ref) => ({ id: `id-${ref}`, ref, matches: true })),
      ...quiet.map((ref) => ({ id: `id-${ref}`, ref, matches: false })),
    ],
    size: matching.length + quiet.length,
  });

  async function openedGroups(
    items: Row[],
    groups: InboxGroup[],
    { more = false, isSearch = false }: { more?: boolean; isSearch?: boolean } = {},
  ) {
    const fake = fakeReader();
    const time = { now: 0 };
    const visit = createInboxVisit(fake.reader, { now: () => time.now, isSearch: () => isSearch });
    visit.open("list-1");
    fake.open("first").resolve({ ...firstPage(items, more), groups });
    await settle();
    return { fake, visit, time };
  }

  /** Answers the open refresh with a first page, its groups, and the held rows still in. */
  async function answerRefreshGroups(
    fake: Fake,
    items: Row[],
    groups: InboxGroup[],
    { stillIn = [], heldGroups = [] }: { stillIn?: Row[]; heldGroups?: InboxGroup[] } = {},
  ): Promise<void> {
    fake
      .open("refresh")
      .resolve({ firstPage: { ...firstPage(items), groups }, heldRows: stillIn, heldGroups });
    await settle();
  }

  const keysOf = (visit: InboxVisit<Row, string>) =>
    visit.getSnapshot().entries.map((entry) => entry.key);
  const headOf = (visit: InboxVisit<Row, string>, key: string) => {
    const entry = visit.getSnapshot().entries.find((candidate) => candidate.key === key);
    if (entry?.kind !== "head") throw new Error(`no head ${key}`);
    return entry.group;
  };

  it("keeps a group's key, fold and current entry when a read names it after another member", async () => {
    const { fake, visit } = await openedGroups(rows("a", "b", "c", "d"), [
      group("a", ["a", "b", "c"]),
    ]);
    visit.fold({ kind: "open" });
    visit.select({ kind: "focus", ref: "b" });
    visit.pushArrived();
    await answerRefreshGroups(fake, rows("a", "b", "c", "d"), [
      { ...group("a", ["a", "b", "c"]), labelRef: "b", label: "Group b" },
    ]);
    expect(keysOf(visit)).toEqual(["group:1", "a", "b", "c", "d"]);
    expect(headOf(visit, "group:1")).toMatchObject({ label: "Group b", isOpen: true });
    expect(visit.getSnapshot().current).toBe("b");
  });

  it("keeps the key with the first part of a split group and lets the other part inherit the fold", async () => {
    const { fake, visit } = await openedGroups(rows("a", "b", "c", "d"), [
      group("a", ["a", "b", "c", "d"]),
    ]);
    visit.fold({ kind: "open" });
    visit.select({ kind: "focus", ref: "c" });
    visit.pushArrived();
    await answerRefreshGroups(fake, rows("a", "b", "c", "d"), [
      group("a", ["a", "b"]),
      group("c", ["c", "d"]),
    ]);
    expect(keysOf(visit)).toEqual(["group:1", "a", "b", "group:2", "c", "d"]);
    expect(headOf(visit, "group:2").isOpen).toBe(true);
    expect(visit.getSnapshot().current).toBe("c");
  });

  it("keeps the key with the larger part of a merge, and the current entry survives", async () => {
    const { fake, visit } = await openedGroups(rows("a", "b", "c", "d", "e"), [
      group("a", ["a", "b", "c"]),
      group("d", ["d", "e"]),
    ]);
    visit.fold({ kind: "open", key: "group:2" });
    visit.select({ kind: "focus", ref: "d" });
    visit.pushArrived();
    await answerRefreshGroups(fake, rows("a", "b", "c", "d", "e"), [
      group("a", ["a", "b", "c", "d", "e"]),
    ]);
    expect(keysOf(visit)).toEqual(["group:1"]);
    expect(visit.getSnapshot().current).toBe("group:1");
  });

  it("dissolves a group the read no longer has, and a current head goes to its first member", async () => {
    const { fake, visit } = await openedGroups(rows("a", "b", "c"), [group("a", ["a", "b"])]);
    expect(visit.getSnapshot().current).toBe("group:1");
    visit.pushArrived();
    await answerRefreshGroups(fake, rows("a", "b", "c"), []);
    expect(keysOf(visit)).toEqual(["a", "b", "c"]);
    expect(visit.getSnapshot().current).toBe("a");
  });

  it("does not take a group member the visit does not hold for an arrival, and drops a held ref that left", async () => {
    const { fake, visit } = await openedGroups(rows("a", "b", "c"), [group("a", ["a", "b", "c"])]);
    visit.pushArrived();
    await answerRefreshGroups(fake, rows("a", "b"), [group("a", ["a", "b", "x"])]);
    const snapshot = visit.getSnapshot();
    expect(snapshot.arrivals).toBe(0);
    expect(snapshot.rows.map((r) => r.ref)).toEqual(["a", "b"]);
    expect(headOf(visit, "group:1").size).toBe(3);
    expect(fake.count("rows")).toBe(0);
    visit.pushArrived();
    await answerRefreshGroups(fake, rows("a"), []);
    expect(keysOf(visit)).toEqual(["a"]);
  });

  it("does not let a refresh issued before an undo drop or regroup the restored members", async () => {
    const { fake, visit } = await openedGroups(rows("a", "b", "c", "d"), [
      group("a", ["a", "b", "c"]),
    ]);
    const receipt = visit.move("dismissed", ["a", "b", "c"]);
    expect(keysOf(visit)).toEqual(["d"]);
    visit.confirmMove(receipt);
    visit.pushArrived();
    const early = fake.open("refresh");
    visit.undo(receipt);
    expect(keysOf(visit)).toEqual(["group:1", "d"]);
    early.resolve({
      firstPage: { ...firstPage(rows("d")), groups: [] },
      heldRows: [],
      heldGroups: [],
    });
    await settle();
    expect(visit.getSnapshot().rows.map((r) => r.ref)).toEqual(["a", "b", "c", "d"]);
    expect(keysOf(visit)).toEqual(["group:1", "d"]);
    expect(visit.getSnapshot().current).toBe("group:1");
    visit.pushArrived();
    await answerRefreshGroups(fake, rows("d"), []);
    expect(visit.getSnapshot().rows.map((r) => r.ref)).toEqual(["d"]);
  });

  it("does not draw a dismissed group's members again while the dismissal is on its way", async () => {
    const { fake, visit } = await openedGroups(rows("a", "b", "c", "x"), [group("a", ["a", "b"])], {
      more: true,
    });
    const receipt = visit.move("dismissed", ["a", "b"]);
    visit.pushArrived();
    await answerRefreshGroups(fake, rows("a", "b", "c", "x"), [group("a", ["a", "b"])]);
    expect(keysOf(visit)).toEqual(["c", "x"]);
    visit.viewportChanged(0, 1);
    fake.open("next").resolve({ rows: rows("a", "b", "y"), groups: [group("a", ["a", "b"])] });
    await settle();
    expect(keysOf(visit)).toEqual(["c", "x", "y"]);
    visit.confirmMove(receipt);
    visit.pushArrived();
    await answerRefreshGroups(fake, rows("c", "x"), [], { stillIn: rows("y") });
    expect(visit.getSnapshot().arrivals).toBe(0);
    expect(keysOf(visit)).toEqual(["c", "x", "y"]);
  });

  it("dismisses an open group with one receipt and moves on past its last member", async () => {
    const { visit } = await openedGroups(rows("a", "b", "c", "d"), [group("a", ["a", "b", "c"])]);
    visit.fold({ kind: "open" });
    visit.select({ kind: "toggle", ref: "a" });
    const receipt = visit.move("dismissed", ["a", "b", "c"]);
    expect(receipt.refs).toEqual(["a", "b", "c"]);
    const snapshot = visit.getSnapshot();
    expect(keysOf(visit)).toEqual(["d"]);
    expect(snapshot.current).toBe("d");
    expect(snapshot.selection.size).toBe(0);
  });

  it("keeps a group whose last matching member was dismissed until a read drops it", async () => {
    const { fake, visit } = await openedGroups(rows("a", "q1", "q2"), [
      group("a", ["a"], ["q1", "q2"]),
    ]);
    visit.move("dismissed", ["a"]);
    expect(keysOf(visit)).toEqual(["group:1"]);
    expect(headOf(visit, "group:1")).toMatchObject({ matchingCount: 0, placedBy: undefined });
    visit.pushArrived();
    await answerRefreshGroups(fake, rows("q1", "q2"), []);
    expect(keysOf(visit)).toEqual(["q1", "q2"]);
  });

  it("ignores a reply with groups that belongs to a list that was switched away from", async () => {
    const { fake, visit } = await openedGroups(rows("a", "b"), [group("a", ["a", "b"])]);
    visit.pushArrived();
    const late = fake.open("refresh");
    visit.open("list-2");
    await answerFirst(fake, rows("x", "y"));
    late.resolve({
      firstPage: { ...firstPage(rows("a", "b")), groups: [group("a", ["a", "b"])] },
      heldRows: [],
      heldGroups: [],
    });
    await settle();
    expect(keysOf(visit)).toEqual(["x", "y"]);
  });

  it("counts an arrival inside a held group once, keeps it out of the group's move, and seats it under the head after Show", async () => {
    const { fake, visit } = await openedGroups(rows("a", "b"), [group("a", ["a", "b"])]);
    visit.fold({ kind: "open" });
    const arrived = [row("x", "x", 5), row("a"), row("b")];
    const withX = [group("x", ["x", "a", "b"])];
    visit.pushArrived();
    await answerRefreshGroups(fake, arrived, withX);
    expect(visit.getSnapshot().arrivals).toBe(1);
    const target = visit.targets("group:1");
    expect(target).toMatchObject({ kind: "group", size: 2 });
    expect(target?.kind === "group" && target.members.map((m) => m.ref)).toEqual(["a", "b"]);
    visit.show();
    await answerRefreshGroups(fake, arrived, withX);
    expect(visit.getSnapshot().arrivals).toBe(0);
    expect(keysOf(visit)).toEqual(["group:1", "x", "a", "b"]);
  });

  describe("selection", () => {
    it("selects a head's matching members with X, all of them with ⇧X, and toggles back", async () => {
      const { visit } = await openedGroups(rows("a", "b", "q", "d"), [
        group("a", ["a", "b"], ["q"]),
      ]);
      visit.select({ kind: "toggle", ref: "group:1" });
      expect([...visit.getSnapshot().selection]).toEqual(["a", "b"]);
      expect(headOf(visit, "group:1").tick).toBe("all");
      visit.select({ kind: "toggle", ref: "group:1" });
      expect(visit.getSnapshot().selection.size).toBe(0);
      visit.select({ kind: "toggle", ref: "group:1", whole: true });
      expect([...visit.getSnapshot().selection]).toEqual(["a", "b", "q"]);
      visit.select({ kind: "toggle", ref: "group:1", whole: true });
      expect(visit.getSnapshot().selection.size).toBe(0);
    });

    it("ticks some when only a member is selected, and a fold keeps the selection", async () => {
      const { visit } = await openedGroups(rows("a", "b", "d"), [group("a", ["a", "b"])]);
      visit.fold({ kind: "open" });
      visit.select({ kind: "toggle", ref: "a" });
      expect(headOf(visit, "group:1").tick).toBe("some");
      visit.fold({ kind: "close", key: "group:1" });
      expect([...visit.getSnapshot().selection]).toEqual(["a"]);
    });

    it("selects a range over entries without repeating a ref, and ⌘A takes things and head matches", async () => {
      const { visit } = await openedGroups(rows("a", "b", "q", "d"), [
        group("a", ["a", "b"], ["q"]),
      ]);
      visit.fold({ kind: "open" });
      visit.select({ kind: "focus", ref: "group:1" });
      visit.step(1, true);
      visit.step(1, true);
      visit.step(1, true);
      visit.step(1, true);
      expect([...visit.getSnapshot().selection].sort()).toEqual(["a", "b", "d", "q"]);
      visit.select({ kind: "all" });
      expect([...visit.getSnapshot().selection].sort()).toEqual(["a", "b", "d"]);
    });
  });

  it("steps over heads, members and the more line, and ← goes to the head", async () => {
    const refs = ["m1", "m2", "m3", "m4", "m5", "m6", "m7", "m8"];
    const { visit } = await openedGroups(rows(...refs, "z"), [group("m1", refs)]);
    visit.step(1);
    expect(visit.getSnapshot().current).toBe("z");
    visit.step(-1);
    visit.fold({ kind: "open" });
    expect(keysOf(visit)).toEqual(["group:1", "m1", "m2", "m3", "m4", "m5", "group:1:more", "z"]);
    visit.step(1);
    expect(visit.getSnapshot().current).toBe("m1");
    visit.fold({ kind: "close" });
    expect(visit.getSnapshot().current).toBe("group:1");
    visit.select({ kind: "focus", ref: "m3" });
    visit.fold({ kind: "close", key: "group:1" });
    expect(visit.getSnapshot().current).toBe("group:1");
    expect(headOf(visit, "group:1").isOpen).toBe(false);
  });

  it("shows 5 of a group of 8, matching members first, and Show more makes the first new member current", async () => {
    const refs = ["m1", "m2", "q1", "q2", "q3", "q4", "q5", "q6"];
    const { visit } = await openedGroups(rows(...refs), [group("m1", ["m1", "m2"], refs.slice(2))]);
    visit.fold({ kind: "open" });
    expect(keysOf(visit).slice(1, 6)).toEqual(["m1", "m2", "q1", "q2", "q3"]);
    const more = visit.getSnapshot().entries.at(-1);
    expect(more).toMatchObject({ kind: "more", hiddenCount: 3 });
    visit.select({ kind: "focus", ref: "group:1:more" });
    visit.fold({ kind: "showMore" });
    expect(keysOf(visit)).toHaveLength(9);
    expect(visit.getSnapshot().current).toBe("q4");
  });

  describe("the first E on a group that just came under the keys", () => {
    const setup = async () => {
      const made = await openedGroups(rows("a", "b", "c", "d", "e"), [
        group("a", ["a", "b"]),
        group("c", ["c", "d"]),
      ]);
      made.time.now = 1000;
      return made;
    };
    const isFresh = (visit: InboxVisit<Row, string>, hoveredKey?: string) => {
      const target = visit.targets(hoveredKey);
      return target?.kind === "group" ? target.isFresh : undefined;
    };

    it("is fresh for 599 ms and not at 600 ms", async () => {
      const { visit, time } = await setup();
      visit.move("dismissed", ["a", "b"]);
      expect(visit.getSnapshot().current).toBe("group:2");
      time.now = 1599;
      expect(isFresh(visit)).toBe(true);
      time.now = 1600;
      expect(isFresh(visit)).toBe(false);
    });

    it("is cleared by a step and by an undo", async () => {
      const { visit } = await setup();
      const receipt = visit.move("dismissed", ["a", "b"]);
      visit.step(1);
      visit.step(-1);
      expect(isFresh(visit)).toBe(false);
      visit.undo(receipt);
      expect(isFresh(visit)).toBe(false);
    });

    it("is never fresh from a hover or a selection", async () => {
      const { visit } = await setup();
      visit.move("dismissed", ["a", "b"]);
      expect(isFresh(visit, "group:2")).toBe(false);
      visit.select({ kind: "toggle", ref: "e" });
      expect(visit.targets()?.kind).toBe("selection");
    });

    it("is not set by a read that moved the current entry", async () => {
      const { fake, visit } = await setup();
      visit.pushArrived();
      await answerRefreshGroups(fake, rows("c", "d", "e"), [group("c", ["c", "d"])]);
      expect(visit.getSnapshot().current).toBe("group:2");
      expect(isFresh(visit)).toBe(false);
    });
  });

  describe("in a search", () => {
    it("opens a group for a hit besides its label, not for a label alone, and an explicit close wins", async () => {
      const { visit } = await openedGroups(
        rows("a", "b", "c", "d"),
        [group("a", ["a", "b"]), group("c", ["c"], ["d"])],
        { isSearch: true },
      );
      expect(headOf(visit, "group:1").isOpen).toBe(true);
      expect(headOf(visit, "group:2").isOpen).toBe(false);
      visit.fold({ kind: "close", key: "group:1" });
      expect(headOf(visit, "group:1").isOpen).toBe(false);
    });

    it("forgets the folds when another list opens", async () => {
      const { fake, visit } = await openedGroups(rows("a", "b"), [group("a", ["a", "b"])]);
      visit.fold({ kind: "open" });
      visit.open("list-2");
      fake
        .open("first")
        .resolve({ ...firstPage(rows("a", "b")), groups: [group("a", ["a", "b"])] });
      await settle();
      expect(headOf(visit, "group:1").isOpen).toBe(false);
    });
  });

  it("keeps the identity of the entries across a read that changes nothing, and across a step", async () => {
    const { fake, visit } = await openedGroups(rows("a", "b", "c"), [group("a", ["a", "b"])]);
    const before = visit.getSnapshot().entries;
    visit.pushArrived();
    await answerRefreshGroups(fake, rows("a", "b", "c"), [group("a", ["a", "b"])]);
    expect(visit.getSnapshot().entries).toBe(before);
    visit.step(1);
    expect(visit.getSnapshot().entries).toBe(before);
  });

  it("keeps a group that a read did not cover, such as one far from the viewport", async () => {
    const items = Array.from({ length: 900 }, (_, i) => row(`t${i}`));
    const far = group("t890", ["t890", "t891"]);
    const { fake, visit } = await openedGroups(items, [far], { more: false });
    visit.pushArrived();
    await answerRefreshGroups(fake, items.slice(0, 200), [], { stillIn: items.slice(200, 400) });
    expect(headOf(visit, "group:1")).toMatchObject({ labelRef: "t890", size: 2 });
  });
});
