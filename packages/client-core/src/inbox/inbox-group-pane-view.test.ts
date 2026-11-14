/** Tests the words and values the pane of a group draws. */
import { describe, expect, it } from "vitest";
import type { EntityLink, EntityPeer, InboxGroupDetail } from "@hercule/contract";
import { buildActiveTask, buildInboxAsk, buildInboxThing } from "./cards.testing";
import { describeInboxGroupHead, describeInboxGroupPane } from "./inbox-group-pane-view";

const NOW = new Date("2026-11-07T12:00:00.000Z");
const PLUGINS = [
  { id: "linear", displayName: "Linear" },
  { id: "github", displayName: "GitHub" },
];

const peer = (ref: string, kind: string, overrides: Partial<EntityPeer> = {}): EntityPeer => ({
  ref,
  kind,
  noun: "Issue",
  yours: false,
  restricted: false,
  ...overrides,
});

const link = (
  fromRef: string,
  toRef: string,
  claim: EntityLink["claim"],
  hasPersonClaim = false,
): EntityLink => ({ fromRef, toRef, claim, hasPersonClaim });

const issue = peer("linear:issue:1", "linear/issue", {
  identifier: "SHOP-142",
  title: "Show the delivery cost",
  status: { label: "In Progress", shape: "half", tone: "active" },
});
const pull = peer("github:pull:2", "github/pull-request", {
  noun: "Pull request",
  identifier: "#6244",
  title: "Delivery cost on the payment step",
});
const bare = peer("github:issue:3", "github/issue", { noun: "Issue" });

const detail = (overrides: Partial<InboxGroupDetail> = {}): InboxGroupDetail => ({
  labelRef: issue.ref,
  label: "Show the delivery cost",
  members: [issue, pull, bare],
  links: [],
  complete: true,
  ...overrides,
});

const askingRow = (ref: string, waitingSince: string) =>
  buildInboxThing("2", {
    ref,
    asks: [buildInboxAsk("a1", "Omar", { say: { say: "Omar mentioned you", tone: "plain" } })],
    askCount: 1,
    waitingSince,
  });

const context = (rows = new Map<string, ReturnType<typeof buildInboxThing>>()) => ({
  plugins: PLUGINS,
  rows,
  now: NOW,
});

describe("describeInboxGroupHead", () => {
  it("counts the members and names each source once, in the order of the first member", () => {
    expect(describeInboxGroupHead(detail(), PLUGINS)).toBe("Linked · 3 things in Linear, GitHub");
  });
});

describe("describeInboxGroupPane members", () => {
  it("puts the members that wait on the user first, longest wait first, and counts them", () => {
    const rows = new Map([
      [pull.ref, askingRow(pull.ref, "2026-11-07T10:00:00.000Z")],
      [bare.ref, askingRow(bare.ref, "2026-11-06T10:00:00.000Z")],
      [issue.ref, buildInboxThing("1", { ref: issue.ref })],
    ]);
    const view = describeInboxGroupPane(detail(), context(rows));
    expect(view.members.map((member) => member.ref)).toEqual([bare.ref, pull.ref, issue.ref]);
    expect(view.waiting).toBe("2 of them wait on you");
    expect(view.members[1]?.why).toEqual({
      who: "Omar",
      rest: "mentioned you",
      more: 0,
      quiet: false,
    });
  });

  it("falls back to the status, then the noun, for a member the Inbox holds no row for", () => {
    const view = describeInboxGroupPane(detail(), context());
    // No row at all: it is not known what waits, so the pane does not claim zero.
    expect(view.waiting).toBe("Not all of it is loaded, so it is not known what waits on you");
    expect(view.members.map((member) => member.why.rest)).toEqual([
      "In Progress",
      "Pull request",
      "Issue",
    ]);
    expect(view.members[2]?.title).toBe("Issue");
  });

  it("says 'waits' for one member, and that the others are not loaded when they have no row", () => {
    const rows = new Map([[pull.ref, askingRow(pull.ref, "2026-11-07T10:00:00.000Z")]]);
    expect(describeInboxGroupPane(detail(), context(rows)).waiting).toBe(
      "1 of them waits on you so far",
    );
    const all = new Map([
      [pull.ref, askingRow(pull.ref, "2026-11-07T10:00:00.000Z")],
      [issue.ref, buildInboxThing("1", { ref: issue.ref })],
      [bare.ref, buildInboxThing("3", { ref: bare.ref })],
    ]);
    expect(describeInboxGroupPane(detail(), context(all)).waiting).toBe("1 of them waits on you");
  });

  it("counts a member whose Task a hand-off made when it still has an ask left", () => {
    const handed = {
      ...askingRow(pull.ref, "2026-11-07T10:00:00.000Z"),
      task: buildActiveTask("task-1"),
    };
    const rows = new Map([
      [pull.ref, handed],
      [issue.ref, buildInboxThing("1", { ref: issue.ref })],
      [bare.ref, buildInboxThing("3", { ref: bare.ref })],
    ]);
    expect(describeInboxGroupPane(detail(), context(rows)).waiting).toBe("1 of them waits on you");
  });
});

describe("describeInboxGroupPane pairs", () => {
  it("names each end by identifier, else title, and words the claim", () => {
    const view = describeInboxGroupPane(
      detail({
        links: [
          link(issue.ref, pull.ref, { type: "source", plugin: "linear" }),
          link(pull.ref, bare.ref, { type: "person" }, true),
        ],
      }),
      context(),
    );
    expect(view.pairs[0]).toMatchObject({
      from: { pluginId: "linear", name: "SHOP-142", isIdentifier: true },
      to: { pluginId: "github", name: "#6244", isIdentifier: true },
      claim: "Linear reports this",
      canUnlink: false,
    });
    expect(view.pairs[1]).toMatchObject({
      to: { name: "Issue", isIdentifier: false },
      claim: "You linked these",
      canUnlink: true,
    });
  });

  it("offers Unlink on a source's pair that a person also claims", () => {
    const view = describeInboxGroupPane(
      detail({ links: [link(issue.ref, pull.ref, { type: "source", plugin: "linear" }, true)] }),
      context(),
    );
    expect(view.pairs[0]).toMatchObject({ claim: "Linear reports this", canUnlink: true });
  });

  it("marks the view cut when the read was", () => {
    expect(describeInboxGroupPane(detail({ complete: false }), context()).isCut).toBe(true);
  });
});
