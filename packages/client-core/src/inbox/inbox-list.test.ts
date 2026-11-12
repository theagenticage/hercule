import { describe, expect, it } from "vitest";
import {
  applyInboxMove,
  applyInboxNextPage,
  applyInboxRefresh,
  changeInboxSelection,
  decideMoveTargets,
  moveInboxCurrent,
  showInboxArrivals,
  startInboxList,
  undoInboxMove,
  type InboxListState,
} from "./inbox-list";

interface Row {
  readonly ref: string;
  readonly title: string;
}
const row = (ref: string, title = ref): Row => ({ ref, title });
const rows = (...refs: string[]) => refs.map((ref) => row(ref));
const refsOf = (state: InboxListState<Row>) => state.rows.map((r) => r.ref);
const start = (...refs: string[]) => startInboxList("list-1", rows(...refs));

/** A refresh whose `refs` reads asked for every held row not on the first page, and found `found`. */
const refresh = (state: InboxListState<Row>, firstPage: Row[], found: Row[] = [], more = false) => {
  const onFirstPage = new Set(firstPage.map((r) => r.ref));
  return applyInboxRefresh(state, {
    listId: state.listId,
    firstPage,
    firstPageHasMore: more,
    askedRefs: state.rows.map((r) => r.ref).filter((ref) => !onFirstPage.has(ref)),
    refsReads: found,
  });
};

const leaves = { leavesList: true };
const stays = { leavesList: false };

describe("refresh", () => {
  it("appends a thing that slid in from the next page quietly, but counts one ranking above held rows", () => {
    const refs = Array.from({ length: 300 }, (_, i) => `t${i}`);
    let state = startInboxList("list-1", rows(...refs.slice(0, 200)), "cursor");
    state = applyInboxMove(state, ["t0"], leaves);
    const afterE = refresh(state, rows(...refs.slice(1, 201)), [], true);
    expect(afterE.arrivals).toEqual([]);
    expect(refsOf(afterE).at(-1)).toBe("t200");
    expect(refsOf(afterE)).toHaveLength(200);
    const withNew = refresh(afterE, rows("fresh", ...refs.slice(1, 201)), [], true);
    expect(withNew.arrivals.map((r) => r.ref)).toEqual(["fresh"]);
  });

  it("counts a thing ranking last as an arrival when no next page exists", () => {
    const state = refresh(start("a", "b"), rows("a", "b", "z"));
    expect(state.arrivals.map((r) => r.ref)).toEqual(["z"]);
  });

  it("updates a held row in place without re-sorting", () => {
    const state = refresh(start("a", "b", "c"), [row("c"), row("b", "new title"), row("a")]);
    expect(refsOf(state)).toEqual(["a", "b", "c"]);
    expect(state.rows[1]!.title).toBe("new title");
    expect(state.arrivals).toEqual([]);
  });

  it("drops a held row that is in no reply, and updates one found by the refs read", () => {
    const held = applyInboxNextPage(startInboxList("list-1", rows("a", "b"), "c1"), {
      listId: "list-1",
      after: "c1",
      rows: rows("c", "d"),
    });
    const state = refresh(held, [row("a")], [row("c", "read by ref")]);
    expect(refsOf(state)).toEqual(["a", "c"]);
    expect(state.rows[1]!.title).toBe("read by ref");
  });

  it("keeps a held row that was not asked for, such as a page appended during the refresh", () => {
    const state = applyInboxRefresh(start("a", "b"), {
      listId: "list-1",
      firstPage: rows("a"),
      firstPageHasMore: false,
      askedRefs: [],
      refsReads: [],
    });
    expect(refsOf(state)).toEqual(["a", "b"]);
  });

  it("holds back a first-page row that is not held and counts it", () => {
    const state = refresh(start("a", "b"), rows("n", "a", "b"));
    expect(refsOf(state)).toEqual(["a", "b"]);
    expect(state.arrivals.map((r) => r.ref)).toEqual(["n"]);
  });

  it("ignores a reply of a superseded list", () => {
    const state = start("a", "b");
    const stale = applyInboxRefresh(state, {
      listId: "old",
      firstPage: [],
      firstPageHasMore: false,
      askedRefs: ["a", "b"],
      refsReads: [],
    });
    expect(stale).toBe(state);
  });
});

describe("Show", () => {
  it("places arrivals where the first page ranks them and makes the first new row current", () => {
    const state = showInboxArrivals(refresh(start("a", "b", "c"), rows("n1", "a", "n2", "b", "c")));
    expect(refsOf(state)).toEqual(["n1", "a", "n2", "b", "c"]);
    expect(state.arrivals).toEqual([]);
    expect(state.current).toBe("n1");
  });

  it("chains arrivals that rank next to each other", () => {
    const state = showInboxArrivals(refresh(start("a"), rows("a", "n1", "n2")));
    expect(refsOf(state)).toEqual(["a", "n1", "n2"]);
    expect(state.current).toBe("n1");
  });

  it("changes nothing when nothing waits", () => {
    const state = start("a");
    expect(showInboxArrivals(state)).toBe(state);
  });
});

describe("next page", () => {
  const paged = () => startInboxList("list-1", rows("a", "b"), "c1");

  it("appends only rows that are not held yet and moves the frontier", () => {
    const state = applyInboxNextPage(paged(), {
      listId: "list-1",
      after: "c1",
      rows: rows("b", "c"),
      nextCursor: "c2",
    });
    expect(refsOf(state)).toEqual(["a", "b", "c"]);
    expect(state.frontier).toBe("c2");
  });

  it("keeps the frontier through a refresh", () => {
    expect(refresh(paged(), rows("a", "b")).frontier).toBe("c1");
  });

  it("ignores a page of another list or one that did not continue from the frontier", () => {
    const state = paged();
    expect(applyInboxNextPage(state, { listId: "old", after: "c1", rows: rows("z") })).toBe(state);
    expect(applyInboxNextPage(state, { listId: "list-1", after: "c0", rows: rows("z") })).toBe(
      state,
    );
  });
});

describe("moves", () => {
  it("removes handled rows at once and makes the next row current", () => {
    const state = applyInboxMove(start("a", "b", "c"), ["a"], leaves);
    expect(refsOf(state)).toEqual(["b", "c"]);
    expect(state.current).toBe("b");
  });

  it("skips next rows that leave too, in the old order", () => {
    const moved = applyInboxMove(
      moveInboxCurrent(start("a", "b", "c", "d"), { by: 1 }),
      ["b", "c"],
      leaves,
    );
    expect(moved.current).toBe("d");
  });

  it("falls back to the previous row after the last one, and to none when empty", () => {
    const state = applyInboxMove(moveInboxCurrent(start("a", "b"), { by: 1 }), ["b"], leaves);
    expect(state.current).toBe("a");
    expect(applyInboxMove(state, ["a"], leaves).current).toBeNull();
  });

  it("settles the current row when a refresh removes it", () => {
    const state = refresh(moveInboxCurrent(start("a", "b", "c"), { by: 1 }), rows("a", "c"));
    expect(state.current).toBe("c");
  });

  it("does not bring a handled row back when a stale refresh still has it", () => {
    const stale = refresh(applyInboxMove(start("a", "b"), ["a"], leaves), rows("a", "b"));
    expect(refsOf(stale)).toEqual(["b"]);
    expect(stale.arrivals).toEqual([]);
  });

  it("undo restores rows at their old index and makes the first current, even after a refresh", () => {
    let state = applyInboxMove(start("a", "b", "c", "d"), ["b", "c"], leaves);
    state = refresh(state, rows("a", "d"));
    state = undoInboxMove(state, ["b", "c"]);
    expect(refsOf(state)).toEqual(["a", "b", "c", "d"]);
    expect(state.current).toBe("b");
  });

  it("prunes the selection to displayed rows after a move", () => {
    const all = changeInboxSelection(start("a", "b", "c"), { kind: "all" });
    expect([...applyInboxMove(all, ["b"], leaves).selection]).toEqual(["a", "c"]);
  });
});

describe("a move whose rows may still belong to the list", () => {
  it("keeps the row, moves current on, and prunes the selection", () => {
    const selected = changeInboxSelection(start("a", "b", "c"), { kind: "toggle", ref: "a" });
    const state = applyInboxMove(selected, ["a"], stays);
    expect(refsOf(state)).toEqual(["a", "b", "c"]);
    expect(state.current).toBe("b");
    expect(state.selection.size).toBe(0);
    expect(state.anchor).toBeNull();
  });

  it("updates the row in place on the next refresh", () => {
    const moved = applyInboxMove(start("a", "b"), ["a"], stays);
    const state = refresh(moved, [row("a", "still asks"), row("b")]);
    expect(state.rows[0]!.title).toBe("still asks");
    expect(state.arrivals).toEqual([]);
  });

  it("drops the row when the next refresh no longer has it", () => {
    const moved = applyInboxMove(start("a", "b"), ["a"], stays);
    expect(refsOf(refresh(moved, rows("b")))).toEqual(["b"]);
  });

  it("makes the handled row current again on undo", () => {
    const moved = applyInboxMove(start("a", "b"), ["a"], stays);
    expect(undoInboxMove(moved, ["a"]).current).toBe("a");
  });

  it("keeps current when every row was handled", () => {
    expect(applyInboxMove(start("a"), ["a"], stays).current).toBe("a");
  });
});

describe("selection", () => {
  it("toggles a row and makes it the anchor", () => {
    const on = changeInboxSelection(start("a", "b"), { kind: "toggle", ref: "b" });
    expect([...on.selection]).toEqual(["b"]);
    expect(on.anchor).toBe("b");
    expect(changeInboxSelection(on, { kind: "toggle", ref: "b" }).selection.size).toBe(0);
  });

  it("extends a range with shift-J and shrinks it with shift-K", () => {
    let state = moveInboxCurrent(start("a", "b", "c", "d"), { by: 1, extend: true });
    state = moveInboxCurrent(state, { by: 1, extend: true });
    expect([...state.selection]).toEqual(["a", "b", "c"]);
    state = moveInboxCurrent(state, { by: -1, extend: true });
    expect([...state.selection]).toEqual(["a", "b"]);
    expect(moveInboxCurrent(state, { by: 1 }).anchor).toBeNull();
  });

  it("selects a range by shift-click from the anchor", () => {
    const anchored = changeInboxSelection(start("a", "b", "c", "d"), { kind: "toggle", ref: "d" });
    const state = changeInboxSelection(anchored, { kind: "extendTo", ref: "b" });
    expect([...state.selection].sort()).toEqual(["b", "c", "d"]);
  });

  it("selects every displayed row and clears on Esc", () => {
    const all = changeInboxSelection(start("a", "b", "c", "d"), { kind: "all" });
    expect(all.selection.size).toBe(4);
    expect(changeInboxSelection(all, { kind: "clear" }).selection.size).toBe(0);
  });

  it("forgets the anchor when its row leaves", () => {
    const state = applyInboxMove(
      changeInboxSelection(start("a", "b"), { kind: "toggle", ref: "b" }),
      ["b"],
      leaves,
    );
    expect(state.anchor).toBeNull();
  });
});

describe("what a move acts on", () => {
  it("from the keyboard: the current row, or the selection when there is one", () => {
    expect(decideMoveTargets(start("a", "b", "c"))).toEqual(["a"]);
    let selected = changeInboxSelection(start("a", "b", "c"), { kind: "toggle", ref: "c" });
    selected = changeInboxSelection(selected, { kind: "toggle", ref: "a" });
    expect(decideMoveTargets(selected)).toEqual(["a", "c"]);
  });

  it("from a hover button: that row, unless it is selected, then the selection", () => {
    let selected = changeInboxSelection(start("a", "b", "c"), { kind: "toggle", ref: "a" });
    selected = changeInboxSelection(selected, { kind: "toggle", ref: "b" });
    expect(decideMoveTargets(selected, "c")).toEqual(["c"]);
    expect(decideMoveTargets(selected, "b")).toEqual(["a", "b"]);
  });

  it("is empty for an empty list", () => {
    expect(decideMoveTargets(startInboxList<Row>("list-1", []))).toEqual([]);
  });
});

describe("a list change", () => {
  it("starts over: no arrivals, selection, anchor or undo memory", () => {
    const old = applyInboxMove(refresh(start("a", "b"), rows("n", "a", "b")), ["a"], leaves);
    const state = startInboxList("list-2", rows("x", "y"));
    expect(old.arrivals.length).toBe(1);
    expect(state.arrivals).toEqual([]);
    expect(state.current).toBe("x");
    expect(undoInboxMove(state, ["a"])).toBe(state);
  });
});

describe("undo after a refresh", () => {
  it("puts back a taken-on row that a refresh dropped, current", () => {
    let state = applyInboxMove(start("a", "b"), ["a"], stays);
    state = applyInboxRefresh(state, {
      listId: "list-1",
      firstPage: rows("b"),
      firstPageHasMore: false,
      askedRefs: ["a"],
      refsReads: [],
    });
    expect(refsOf(state)).toEqual(["b"]);
    state = undoInboxMove(state, ["a"]);
    expect(refsOf(state)).toEqual(["a", "b"]);
    expect(state.current).toBe("a");
  });

  it("is not undone by a refresh that was read before the undo", () => {
    let state = applyInboxMove(start("a", "b"), ["a"], leaves);
    state = refresh(state, rows("b"));
    state = undoInboxMove(state, ["a"]);
    state = refresh(state, rows("b"));
    expect(refsOf(state)).toEqual(["a", "b"]);
    expect(refsOf(refresh(state, rows("b")))).toEqual(["b"]);
  });

  it("never duplicates a row that came back as an arrival and was shown", () => {
    let state = applyInboxMove(start("a", "b"), ["a"], leaves);
    state = refresh(state, rows("b"));
    state = refresh(state, rows("a", "b"));
    expect(state.arrivals.map((r) => r.ref)).toEqual(["a"]);
    state = showInboxArrivals(state);
    state = undoInboxMove(state, ["a"]);
    expect(refsOf(state)).toEqual(["a", "b"]);
  });

  it("lets a next page carry a row that revived after the server dropped it", () => {
    let state = applyInboxMove(startInboxList("list-1", rows("a", "b"), "c1"), ["a"], leaves);
    state = refresh(state, rows("b"));
    state = applyInboxNextPage(state, { listId: "list-1", after: "c1", rows: rows("a", "c") });
    expect(refsOf(state)).toEqual(["b", "a", "c"]);
  });
});
