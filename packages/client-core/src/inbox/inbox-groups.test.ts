import { describe, expect, it } from "vitest";
import {
  buildEntries,
  findEntryKey,
  gatherGroupRows,
  reconcileGroups,
  removeMembers,
  settleKey,
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
const entriesOf = (refs: string[], groups: HeldGroup[], extra = {}) =>
  buildEntries({
    rows: rows(...refs),
    groups,
    folds: NO_FOLDS,
    isSearch: false,
    selection: new Set<string>(),
    ...extra,
  });

describe("reconcileGroups", () => {
  const base = { covered: new Set<string>(), nextNumber: 3, currentGroup: null } as const;

  it("gives a tie in overlap to the held group of the current row", () => {
    const previous = [held("group:1", "a", "b"), held("group:2", "c", "d")];
    const result = reconcileGroups({
      ...base,
      previous,
      incoming: [incoming("a", "b", "c", "d")],
      covered: new Set(["a", "b", "c", "d"]),
      currentGroup: "group:2",
    });
    expect(result.groups.map((group) => group.key)).toEqual(["group:2"]);
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
    expect(result.inherit.size).toBe(0);
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

  it("draws a group with one held member as a thing", () => {
    expect(entriesOf(["a", "b"], [held("group:1", "a", "x")]).map((e) => e.kind)).toEqual([
      "thing",
      "thing",
    ]);
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
});
