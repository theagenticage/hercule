/** Tests how things on the Inbox form groups, how a group is named, and how a page is cut into units. */
import { describe, expect, it } from "vitest";
import {
  buildInboxGroup,
  cutPage,
  decideGroups,
  findUnitKey,
  type GroupCandidate,
} from "./inbox-groups";

const thing = (ref: string, createdAt = "2026-01-01T00:00:00.000Z", kind = "acme/ticket") =>
  ({ ref, kind, title: `Title ${ref}`, createdAt }) satisfies GroupCandidate;
const link = (fromRef: string, toRef: string) => ({ fromRef, toRef });
const noKinds = new Map<string, number>();

describe("decideGroups", () => {
  it("joins a chain into one group and leaves a thing with no link out", () => {
    const groups = decideGroups(
      [thing("a"), thing("b"), thing("c"), thing("d"), thing("lone")],
      [link("a", "b"), link("c", "b"), link("d", "c")],
      noKinds,
    );
    expect(groups.get("a")!.memberRefs).toEqual(["a", "b", "c", "d"]);
    expect(groups.get("d")).toBe(groups.get("a"));
    expect(groups.has("lone")).toBe(false);
  });

  it("handles a cycle, a repeated link and a link to itself", () => {
    const groups = decideGroups(
      [thing("a"), thing("b"), thing("c"), thing("x")],
      [link("a", "b"), link("b", "c"), link("c", "a"), link("a", "b"), link("x", "x")],
      noKinds,
    );
    expect(groups.get("b")!.memberRefs).toEqual(["a", "b", "c"]);
    expect(groups.has("x")).toBe(false);
  });

  it("does not join through a thing that is not on the Inbox", () => {
    const groups = decideGroups(
      [thing("a"), thing("c")],
      [link("a", "off-inbox"), link("off-inbox", "c")],
      noKinds,
    );
    expect(groups.size).toBe(0);
  });

  it("keeps two separate groups apart", () => {
    const groups = decideGroups(
      [thing("a"), thing("b"), thing("c"), thing("d")],
      [link("a", "b"), link("c", "d")],
      noKinds,
    );
    expect(groups.get("a")).not.toBe(groups.get("c"));
  });

  describe("the label", () => {
    const kinds = new Map([
      ["acme/epic", 3],
      ["acme/ticket", 1],
    ]);

    it("is the member of the most lasting kind, a kind that is not declared counting 0", () => {
      const groups = decideGroups(
        [
          thing("a", "2026-01-01T00:00:00.000Z", "acme/ticket"),
          thing("b", "2026-02-01T00:00:00.000Z", "acme/epic"),
          thing("c", "2025-01-01T00:00:00.000Z", "other/gone"),
        ],
        [link("a", "b"), link("b", "c")],
        kinds,
      );
      expect(groups.get("a")).toMatchObject({ labelRef: "b", label: "Title b" });
    });

    it("breaks a tie by the oldest, then by the lowest ref", () => {
      const byAge = decideGroups(
        [thing("a", "2026-02-01T00:00:00.000Z"), thing("b", "2026-01-01T00:00:00.000Z")],
        [link("a", "b")],
        noKinds,
      );
      expect(byAge.get("a")!.labelRef).toBe("b");
      const byRef = decideGroups([thing("b"), thing("a")], [link("a", "b")], noKinds);
      expect(byRef.get("b")!.labelRef).toBe("a");
    });
  });
});

describe("findUnitKey", () => {
  it("is the label ref of a group, or the ref of a thing in none", () => {
    const groups = decideGroups([thing("a"), thing("b")], [link("b", "a")], noKinds);
    expect(findUnitKey(groups, "b")).toBe("a");
    expect(findUnitKey(groups, "lone")).toBe("lone");
  });
});

describe("cutPage", () => {
  const unit = (key: string, size: number) => ({ key, size });

  it("takes whole units while they fit and stops at the first that does not", () => {
    const cut = cutPage([unit("a", 3), unit("b", 4), unit("c", 1)], 5);
    expect(cut.kept.map(({ unit: kept, take }) => [kept.key, take])).toEqual([["a", 3]]);
    // `c` would fit, but it does not jump ahead of `b`.
    expect(cut.more).toBe(true);
  });

  it("keeps everything, with no more, when all of it fits", () => {
    const cut = cutPage([unit("a", 3), unit("b", 2)], 5);
    expect(cut.kept).toHaveLength(2);
    expect(cut.more).toBe(false);
  });

  it("cuts a first unit that is larger than the budget to the budget and moves past it", () => {
    const cut = cutPage([unit("big", 9), unit("b", 1)], 5);
    expect(cut.kept.map(({ unit: kept, take }) => [kept.key, take])).toEqual([["big", 5]]);
    expect(cut.more).toBe(true);
    expect(cutPage([unit("big", 9)], 5).more).toBe(false);
  });

  it("returns an empty cut for no units", () => {
    expect(cutPage([], 5)).toEqual({ kept: [], more: false });
  });
});

describe("buildInboxGroup", () => {
  const group = decideGroups(
    [thing("a"), thing("b"), thing("c")],
    [link("a", "b"), link("b", "c")],
    noKinds,
  ).get("a")!;
  const member = (ref: string, matches: boolean) => ({ id: `id-${ref}`, ref, matches });

  it("lists the members that match first, then the others, each part in the order given", () => {
    const built = buildInboxGroup(group, [
      member("c", false),
      member("a", true),
      member("b", false),
      member("d", true),
    ]);
    expect(built.members.map((m) => m.ref)).toEqual(["a", "d", "c", "b"]);
    expect(built.size).toBe(4);
  });

  it("lists the first 1000 members of a larger group and still counts them all", () => {
    const many = Array.from({ length: 1005 }, (_, index) => member(`m${index}`, index === 1004));
    const built = buildInboxGroup(group, many);
    expect(built.members).toHaveLength(1000);
    expect(built.members[0]!.ref).toBe("m1004");
    expect(built.size).toBe(1005);
  });
});
