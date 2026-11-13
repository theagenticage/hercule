import { describe, expect, it } from "vitest";
import {
  buildEntries,
  buildMoreKey,
  findEntryKey,
  findFoldChoice,
  gatherGroupRows,
  keepUnchangedEntries,
  parseMoreKey,
  reconcileGroups,
  removeMembers,
  settleKey,
  writeFoldChoice,
  type HeldGroup,
  type IncomingGroup,
} from "./inbox-groups";

const member = (ref: string, matches = true) => ({ id: `id-${ref}`, ref, matches });
const held = (key: HeldGroup["key"], ...refs: string[]): HeldGroup => ({
  key,
  labelRef: refs[0]!,
  label: refs[0]!,
  members: refs.map((ref) => member(ref)),
  size: refs.length,
});
const incoming = (...refs: string[]): IncomingGroup => ({
  labelRef: refs[0]!,
  label: refs[0]!,
  members: refs.map((ref) => member(ref)),
  size: refs.length,
});
const rows = (...refs: string[]) => refs.map((ref) => ({ ref }));
const NO_FOLDS = new Map();
/** The choice of an opened group, written to each of `refs`. */
const openFolds = (refs: string[]) =>
  new Map(refs.map((ref) => [ref, { isOpen: true, isExpanded: false, seq: 1 }]));
const entriesOf = (refs: string[], groups: HeldGroup[], extra = {}) =>
  buildEntries({
    rows: rows(...refs),
    groups,
    folds: NO_FOLDS,
    isSearch: false,
    selection: new Set<string>(),
    notOnList: new Set<string>(),
    ...extra,
  });

describe("reconcileGroups", () => {
  const base = { covered: new Set<string>(), nextNumber: 3 } as const;

  it("gives a merge the key of the group it overlaps most, and a tie to the first held group", () => {
    const previous = [held("group:1", "a", "b"), held("group:2", "c", "d", "e")];
    const covered = new Set(["a", "b", "c", "d", "e"]);
    const merged = reconcileGroups({
      ...base,
      previous,
      incoming: [incoming("a", "b", "c", "d", "e")],
      covered,
    });
    expect(merged.groups.map((group) => group.key)).toEqual(["group:2"]);
    const tied = reconcileGroups({
      ...base,
      previous,
      incoming: [incoming("a", "b", "c", "d")],
      covered,
    });
    expect(tied.groups.map((group) => group.key)).toEqual(["group:1"]);
  });

  it("keeps a held group the read did not mention, less the members it covered", () => {
    const result = reconcileGroups({
      ...base,
      previous: [held("group:1", "a", "b", "c")],
      incoming: [],
      covered: new Set(["a"]),
    });
    expect(result.groups.map((group) => [group.key, group.size])).toEqual([["group:1", 2]]);
    const dissolved = reconcileGroups({
      ...base,
      previous: [held("group:1", "a", "b")],
      incoming: [],
      covered: new Set(["a"]),
    });
    expect(dissolved.groups).toEqual([]);
  });

  it("mints a fresh key for a group with no overlap and drops one of a single member", () => {
    const result = reconcileGroups({
      ...base,
      previous: [held("group:1", "a", "b")],
      incoming: [incoming("x", "y"), incoming("z")],
    });
    expect(result.groups.map((group) => group.key)).toEqual(["group:3", "group:1"]);
    expect(result.nextNumber).toBe(4);
  });
});

describe("removeMembers", () => {
  it("dissolves a group left with fewer than two members and counts the size down", () => {
    const groups = [held("group:1", "a", "b", "c"), held("group:2", "d", "e")];
    expect(removeMembers(groups, new Set(["a", "d"]))).toEqual([
      { ...groups[0], members: [member("b"), member("c")], size: 2 },
    ]);
  });
});

describe("buildEntries", () => {
  it("gathers a group's held members under its first held member", () => {
    const groups = [held("group:1", "a", "c")];
    expect(gatherGroupRows(rows("a", "b", "c"), groups).map((row) => row.ref)).toEqual([
      "a",
      "c",
      "b",
    ]);
  });

  it("draws a group with one held member as a head that counts the members not loaded", () => {
    const entries = entriesOf(["a", "b"], [held("group:1", "a", "x")]);
    expect(entries.map((e) => e.kind)).toEqual(["head", "thing"]);
    expect(entries[0]).toMatchObject({
      kind: "head",
      group: { unloadedCount: 1, size: 2 },
    });
  });

  it("numbers a member within its group and counts the group's size, not the loaded rows", () => {
    const groups = [{ ...held("group:1", "x", "a", "b"), size: 9 }];
    const entries = entriesOf(["a", "b"], groups, { folds: openFolds(["x", "a", "b"]) });
    expect(entries.map((e) => e.kind === "member" && [e.position, e.of])).toEqual([
      false,
      [2, 9],
      [3, 9],
    ]);
  });

  it("says on the more line how many held members it hides and how many are not loaded yet", () => {
    const refs = Array.from({ length: 8 }, (_, n) => `m${n}`);
    const groups = [{ ...held("group:1", ...refs), size: 12 }];
    const entries = entriesOf(refs, groups, { folds: openFolds(refs) });
    expect(entries.at(-1)).toMatchObject({
      kind: "more",
      key: "group:1:more",
      hiddenCount: 3,
      unloadedCount: 4,
    });
  });

  it("builds and parses the key of a group's more line, and parses nothing else", () => {
    expect(buildMoreKey("group:3")).toBe("group:3:more");
    expect(parseMoreKey("group:3:more")).toBe("group:3");
    expect(parseMoreKey("group:3")).toBeNull();
    expect(parseMoreKey("github:pr:1")).toBeNull();
  });

  it("ticks all when every held matching member is selected and some when a quiet one is", () => {
    const groups = [{ ...held("group:1", "a", "b"), members: [member("a"), member("b", false)] }];
    const tick = (selected: string[]) => {
      const head = entriesOf(["a", "b"], groups, { selection: new Set(selected) })[0];
      return head?.kind === "head" ? head.group.tick : undefined;
    };
    expect(tick([])).toBe("none");
    expect(tick(["b"])).toBe("some");
    expect(tick(["a"])).toBe("all");
  });
});

describe("keepUnchangedEntries", () => {
  const build = (list: { readonly ref: string }[], groups: HeldGroup[]) =>
    buildEntries({
      rows: list,
      groups,
      folds: NO_FOLDS,
      isSearch: false,
      selection: new Set(),
      notOnList: new Set(),
    });

  it("keeps the object of every entry that did not change when a row comes in at the top", () => {
    const [a, b, c] = rows("a", "b", "c");
    const groups = [held("group:1", "b", "c")];
    const before = build([a!, b!, c!], groups);
    const after = keepUnchangedEntries(before, build([{ ref: "new" }, a!, b!, c!], groups));
    expect(after.map((entry) => entry.key)).toEqual(["new", "a", "group:1"]);
    expect(after.slice(1)).toEqual(before);
    expect(after[1]).toBe(before[0]);
    expect(after[2]).toBe(before[1]);
  });

  it("takes the new entry of a changed row, and returns the previous list when nothing changed", () => {
    const [a, b] = rows("a", "b");
    const before = build([a!, b!], []);
    const changed = keepUnchangedEntries(before, build([a!, { ref: "b" }], []));
    expect(changed[0]).toBe(before[0]);
    expect(changed[1]).not.toBe(before[1]);
    expect(keepUnchangedEntries(before, build([a!, b!], []))).toBe(before);
  });
});

describe("findEntryKey and settleKey", () => {
  const groups = [held("group:1", "a", "b")];
  const entries = entriesOf(["a", "b", "c"], groups);

  it("finds the head that shows a member inside a closed group", () => {
    expect(findEntryKey(entries, "b")).toBe("group:1");
    expect(findEntryKey(entries, "c")).toBe("c");
    expect(findEntryKey(entries, "zzz")).toBeNull();
  });

  it("settles a gone entry on the next one in the old order, else the previous, else the first", () => {
    const next = entriesOf(["c"], []);
    expect(settleKey(["group:1", "c"], next, "group:1", groups)).toBe("c");
    expect(settleKey(["c", "d"], next, "d", [])).toBe("c");
    expect(settleKey([], next, "zzz", [])).toBe("c");
    expect(settleKey([], [], "zzz", [])).toBeNull();
  });

  it("settles a dissolved head on its first member that is still an entry", () => {
    const loose = entriesOf(["a", "b", "c"], []);
    expect(settleKey(["group:1", "c"], loose, "group:1", groups)).toBe("a");
  });

  it("settles a head whose group went into a closed group on that group's head, not a neighbour", () => {
    const merged = entriesOf(["x", "a", "b", "c"], [held("group:2", "x", "a", "b")]);
    expect(settleKey(["group:1", "c"], merged, "group:1", groups)).toBe("group:2");
    expect(settleKey(["group:1:more", "c"], merged, "group:1:more", groups)).toBe("group:2");
  });
});

describe("the fold of a group", () => {
  const choice = (isOpen: boolean, seq: number) => ({ isOpen, isExpanded: false, seq });

  it("is the latest choice among the group's members", () => {
    const group = held("group:1", "a", "b", "c");
    expect(findFoldChoice(group, new Map())).toBeUndefined();
    const folds = new Map([
      ["a", choice(true, 1)],
      ["c", choice(false, 4)],
      ["zzz", choice(true, 9)],
    ]);
    expect(findFoldChoice(group, folds)).toEqual(choice(false, 4));
  });

  it("is written to every member of the group and to none other", () => {
    const folds = writeFoldChoice(
      new Map([["zzz", choice(false, 1)]]),
      held("group:1", "a", "b"),
      choice(true, 2),
    );
    expect([...folds]).toEqual([
      ["zzz", choice(false, 1)],
      ["a", choice(true, 2)],
      ["b", choice(true, 2)],
    ]);
  });
});
