/** Tests which pane the Inbox shows for the current line, and what Return does there. */
import { describe, expect, it } from "vitest";
import { decideInboxActivation, findPaneSubject } from "./inbox-current";
import { buildEntries, type HeldGroup } from "./inbox-groups";

const row = (ref: string) => ({ ref, arrival: 0 });
const [a, b, c] = [row("a"), row("b"), row("c")];
const group: HeldGroup = {
  key: "group:1",
  labelRef: "b",
  label: "Group b",
  members: ["a", "b"].map((ref) => ({ id: `id-${ref}`, ref, matches: true })),
  size: 2,
};

/** A ready snapshot of the rows a, b (a group) and c, with the group open or closed. */
const snapshotOf = ({
  current,
  selection = [],
  isOpen = false,
}: {
  current: string | null;
  selection?: string[];
  isOpen?: boolean;
}) => ({
  status: "ready" as const,
  rows: [a, b, c],
  entries: buildEntries({
    rows: [a, b, c],
    groups: [group],
    folds: new Map(
      isOpen ? ["a", "b"].map((ref) => [ref, { isOpen, isExpanded: false, seq: 1 }]) : [],
    ),
    isSearch: false,
    selection: new Set(selection),
    notOnList: new Set(),
  }),
  current,
  selection: new Set(selection),
});

describe("findPaneSubject", () => {
  it("is the current thing, alone or in an open group", () => {
    expect(findPaneSubject(snapshotOf({ current: "c" }))).toEqual({ kind: "thing", thing: c });
    expect(findPaneSubject(snapshotOf({ current: "a", isOpen: true }))).toEqual({
      kind: "thing",
      thing: a,
    });
  });

  it("is the group, by its label's ref, on its head", () => {
    expect(findPaneSubject(snapshotOf({ current: "group:1" }))).toEqual({
      kind: "group",
      labelRef: "b",
    });
  });

  it("is the selection for several things, or for one that is not current", () => {
    expect(findPaneSubject(snapshotOf({ current: "c", selection: ["a", "c"] }))).toEqual({
      kind: "selection",
      thing: c,
      rows: [a, c],
    });
    expect(findPaneSubject(snapshotOf({ current: "group:1", selection: ["c"] }))).toEqual({
      kind: "selection",
      thing: c,
      rows: [c],
    });
    expect(findPaneSubject(snapshotOf({ current: "c", selection: ["c"] }))).toEqual({
      kind: "thing",
      thing: c,
    });
  });

  it("is nothing while the list is not ready or nothing is current", () => {
    expect(findPaneSubject({ ...snapshotOf({ current: "c" }), status: "loading" })).toEqual({
      kind: "none",
    });
    expect(findPaneSubject(snapshotOf({ current: null }))).toEqual({ kind: "none" });
  });
});

describe("decideInboxActivation", () => {
  it("opens a closed group, and shows the pane of an open one only while the pane is hidden", () => {
    expect(decideInboxActivation(snapshotOf({ current: "group:1" }), true)).toBe("openGroup");
    expect(decideInboxActivation(snapshotOf({ current: "group:1", isOpen: true }), true)).toBe(
      "showPane",
    );
    expect(decideInboxActivation(snapshotOf({ current: "group:1", isOpen: true }), false)).toBe(
      "openGroup",
    );
  });

  it("shows the pane for a thing while it is hidden, else answers its ask", () => {
    expect(decideInboxActivation(snapshotOf({ current: "c" }), true)).toBe("showPane");
    expect(decideInboxActivation(snapshotOf({ current: "c" }), false)).toBe("answerAsk");
    expect(decideInboxActivation(snapshotOf({ current: null }), true)).toBe("none");
  });
});
