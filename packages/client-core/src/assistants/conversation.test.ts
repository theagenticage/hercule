/**
 * Tests the functions the conversation screens read their data through:
 * - `findWebConversation(items)` picks the assistant's web conversation from
 *   the result of `conversation.query`.
 * - `flattenMessagePages(pages)` turns the pages of
 *   `conversation.queryMessages`, read newest first, into one list, oldest
 *   first.
 * - `mergeNewestMessagePage(held, newest)` joins a fresh read of the newest
 *   page into the pages already held.
 * - `mergeSentMessage(held, message)` joins a message the owner just sent
 *   into the pages already held, or tells the screen to read the newest page.
 * - `findAnsweredAssistantId(session)` names the assistant a session answered.
 * - `canSteerOrCancelQueuedInputs(session)` tells whether the session view
 *   offers Steer and Cancel on queued inputs.
 * - `chooseMessageStamps(messages, timezone)` picks the time separators shown
 *   above the messages.
 */
import { describe, expect, it } from "vitest";
import type { Conversation, ConversationMessage } from "@hercule/contract";
import { buildSession } from "../threads/workspaces.testing";
import {
  canSteerOrCancelQueuedInputs,
  chooseMessageStamps,
  findAnsweredAssistantId,
  findWebConversation,
  flattenMessagePages,
  mergeNewestMessagePage,
  mergeSentMessage,
  type MessagePage,
} from "./conversation";

const WEB: Conversation = {
  id: "01a06d02-c000-7000-8000-000000000001",
  assistantId: "01a06d02-a000-7000-8000-000000000001",
  channel: "web",
  containerKey: null,
  createdAt: "2026-09-25T09:00:00.000Z",
};

/** Builds the owner's message at `position` in the web conversation. */
const buildMessage = (position: number): ConversationMessage => ({
  id: `01a06d02-d000-7000-8000-00000000000${String(position)}`,
  conversationId: WEB.id,
  containerKey: null,
  position,
  senderRole: "owner",
  senderLabel: "You",
  text: `message ${String(position)}`,
  sessionId: null,
  turnId: null,
  itemId: null,
  actor: "user",
  createdAt: `2026-09-25T09:0${String(position)}:00.000Z`,
});

describe("findWebConversation", () => {
  it("returns the conversation on the web channel", () => {
    expect(findWebConversation([WEB])).toEqual(WEB);
  });

  it("returns null when there is no conversation", () => {
    expect(findWebConversation([])).toBeNull();
  });
});

describe("flattenMessagePages", () => {
  it("returns the messages of every page, oldest first", () => {
    const pages = [
      { items: [buildMessage(5), buildMessage(4), buildMessage(3)], nextCursor: "after-3" },
      { items: [buildMessage(2), buildMessage(1)] },
    ];

    expect(flattenMessagePages(pages).map((message) => message.position)).toEqual([1, 2, 3, 4, 5]);
  });

  it("returns no messages for no pages", () => {
    expect(flattenMessagePages([])).toEqual([]);
  });
});

/** Builds a message at `position`, with `text` to tell a fresh copy from a held one. */
const buildPositioned = (position: number, text = "held"): ConversationMessage => ({
  ...buildMessage(1),
  id: `message-${String(position)}`,
  position,
  text,
});

/** Builds a page holding the messages from `from` down to `to`, newest first. */
const buildPage = (from: number, to: number, text?: string, nextCursor?: string): MessagePage => ({
  items: Array.from({ length: from - to + 1 }, (_, index) => buildPositioned(from - index, text)),
  ...(nextCursor === undefined ? {} : { nextCursor }),
});

/** Returns each page as "<position>:<text>" per message, newest first. */
const describePages = (pages: readonly MessagePage[]) =>
  pages.map((page) => page.items.map((message) => `${String(message.position)}:${message.text}`));

describe("mergeNewestMessagePage", () => {
  it("returns the newest page alone when nothing is held", () => {
    const newest = buildPage(5, 1);

    expect(mergeNewestMessagePage(undefined, newest)).toEqual({
      pages: [newest],
      pageParams: [undefined],
    });
  });

  it("returns the newest page alone when the held pages hold no message", () => {
    const newest = buildPage(1, 1);
    const held = { pages: [{ items: [] }], pageParams: [undefined] };

    expect(mergeNewestMessagePage(held, newest)).toEqual({
      pages: [newest],
      pageParams: [undefined],
    });
  });

  it("adds the messages stored since the held ones to the newest page, and keeps the cursors", () => {
    const held = {
      pages: [buildPage(10, 6, "held", "c5"), buildPage(5, 1)],
      pageParams: [undefined, "c5"],
    };
    // A page holds five messages, so the fresh read stops at 8.
    const newest = buildPage(12, 8, "fresh", "c7");

    const merged = mergeNewestMessagePage(held, newest);

    expect(describePages(merged.pages)).toEqual([
      ["12:fresh", "11:fresh", "10:fresh", "9:fresh", "8:fresh", "7:held", "6:held"],
      ["5:held", "4:held", "3:held", "2:held", "1:held"],
    ]);
    expect(merged.pages[0]?.nextCursor).toBe("c5");
    expect(merged.pages[1]?.nextCursor).toBeUndefined();
    expect(merged.pageParams).toEqual([undefined, "c5"]);
  });

  it("replaces a held message by its fresh copy when no message is new", () => {
    const held = { pages: [buildPage(3, 1)], pageParams: [undefined] };

    const merged = mergeNewestMessagePage(held, buildPage(3, 1, "fresh"));

    expect(describePages(merged.pages)).toEqual([["3:fresh", "2:fresh", "1:fresh"]]);
  });

  it("joins a fresh page that starts right after the newest held message", () => {
    const held = { pages: [buildPage(5, 1)], pageParams: [undefined] };

    const merged = mergeNewestMessagePage(held, buildPage(10, 6, "fresh", "c5"));

    expect(merged.pages.map((page) => page.items.length)).toEqual([10]);
    expect(merged.pages[0]?.nextCursor).toBeUndefined();
    expect(merged.pageParams).toEqual([undefined]);
  });

  it("returns the newest page alone when a gap would sit between it and the held pages", () => {
    const held = {
      pages: [buildPage(10, 6, "held", "c5"), buildPage(5, 1)],
      pageParams: [undefined, "c5"],
    };
    const newest = buildPage(20, 16, "fresh", "c15");

    expect(mergeNewestMessagePage(held, newest)).toEqual({
      pages: [newest],
      pageParams: [undefined],
    });
  });

  it("returns the newest page alone when it holds no message", () => {
    const held = { pages: [buildPage(3, 1)], pageParams: [undefined] };
    const newest = { items: [] };

    expect(mergeNewestMessagePage(held, newest)).toEqual({
      pages: [newest],
      pageParams: [undefined],
    });
  });

  it("replaces a message on an older page by its fresh copy, and keeps that page", () => {
    // The newest held page holds two messages, so a fresh page of five
    // reaches into the page before it.
    const held = {
      pages: [buildPage(6, 5, "held", "c4"), buildPage(4, 3, "held", "c2"), buildPage(2, 1)],
      pageParams: [undefined, "c4", "c2"],
    };

    const merged = mergeNewestMessagePage(held, buildPage(7, 3, "fresh", "c2"));

    expect(describePages(merged.pages)).toEqual([
      ["7:fresh", "6:fresh", "5:fresh", "4:fresh", "3:fresh"],
      [],
      ["2:held", "1:held"],
    ]);
    expect(merged.pages.map((page) => page.nextCursor)).toEqual(["c4", "c2", undefined]);
    expect(merged.pageParams).toEqual([undefined, "c4", "c2"]);
    expect(flattenMessagePages(merged.pages).map((message) => message.position)).toEqual([
      1, 2, 3, 4, 5, 6, 7,
    ]);
  });

  it("leaves the held pages as they were", () => {
    const held = { pages: [buildPage(3, 1)], pageParams: [undefined] };
    const before = structuredClone(held);

    mergeNewestMessagePage(held, buildPage(4, 2, "fresh"));

    expect(held).toEqual(before);
  });
});

describe("mergeSentMessage", () => {
  it("returns nothing-held when no pages are held, so a closed screen gets no entry", () => {
    expect(mergeSentMessage(undefined, buildPositioned(4, "sent"))).toEqual({
      kind: "nothing-held",
    });
  });

  it("adds the message right after the newest held one to the newest page", () => {
    const held = {
      pages: [buildPage(3, 2, "held", "c1"), buildPage(1, 1)],
      pageParams: [undefined, "c1"],
    };

    const merge = mergeSentMessage(held, buildPositioned(4, "sent"));

    expect(merge.kind).toBe("merged");
    if (merge.kind !== "merged") return;
    expect(describePages(merge.pages.pages)).toEqual([["4:sent", "3:held", "2:held"], ["1:held"]]);
    expect(merge.pages.pageParams).toEqual([undefined, "c1"]);
  });

  it("replaces a held copy of the message, as a push may have stored it first", () => {
    const held = { pages: [buildPage(4, 1)], pageParams: [undefined] };

    const merge = mergeSentMessage(held, buildPositioned(4, "sent"));

    expect(merge.kind === "merged" && describePages(merge.pages.pages)).toEqual([
      ["4:sent", "3:held", "2:held", "1:held"],
    ]);
  });

  it("asks for the newest page when messages were stored since the held ones", () => {
    const held = { pages: [buildPage(3, 1)], pageParams: [undefined] };

    expect(mergeSentMessage(held, buildPositioned(5, "sent"))).toEqual({
      kind: "needs-newest-page",
    });
  });

  it("asks for the newest page when the held pages hold no message to join", () => {
    const held = { pages: [{ items: [] }], pageParams: [undefined] };

    expect(mergeSentMessage(held, buildPositioned(1, "sent"))).toEqual({
      kind: "needs-newest-page",
    });
  });
});

describe("findAnsweredAssistantId", () => {
  it("returns the agent of a session in a conversation", () => {
    const session = buildSession({ id: "s1", agentId: "ada", conversationId: "c1" });

    expect(findAnsweredAssistantId(session)).toBe("ada");
  });

  it("returns null for a session that runs an agent outside a conversation", () => {
    expect(findAnsweredAssistantId(buildSession({ id: "s1", agentId: "ada" }))).toBeNull();
  });

  it("returns null for a Thread", () => {
    expect(findAnsweredAssistantId(buildSession({ id: "t1" }))).toBeNull();
  });
});

describe("canSteerOrCancelQueuedInputs", () => {
  it("returns true for a Thread", () => {
    expect(canSteerOrCancelQueuedInputs(buildSession({ id: "t1" }))).toBe(true);
  });

  it("returns true for a session that runs an agent outside a conversation", () => {
    expect(canSteerOrCancelQueuedInputs(buildSession({ id: "s1", agentId: "ada" }))).toBe(true);
  });

  it("returns false for a session in a conversation", () => {
    const session = buildSession({ id: "s1", agentId: "ada", conversationId: "c1" });

    expect(canSteerOrCancelQueuedInputs(session)).toBe(false);
  });
});

describe("chooseMessageStamps", () => {
  /** Builds a message from `senderRole`, sent at `createdAt`. */
  const buildSentMessage = (
    position: number,
    senderRole: ConversationMessage["senderRole"],
    createdAt: string,
  ): ConversationMessage => ({ ...buildMessage(position), senderRole, createdAt });

  it("puts a separator above each of the owner's messages, in the given zone", () => {
    const messages = [
      buildSentMessage(1, "owner", "2026-09-25T09:00:00.000Z"),
      buildSentMessage(2, "owner", "2026-09-25T10:30:00.000Z"),
    ];

    expect(chooseMessageStamps(messages, "Europe/Amsterdam")).toEqual([
      "25 Sep 11:00",
      "25 Sep 12:30",
    ]);
  });

  it("puts none above a reply or a notice, which follow under the owner's time", () => {
    const messages = [
      buildSentMessage(1, "owner", "2026-09-25T09:00:00.000Z"),
      buildSentMessage(2, "assistant", "2026-09-25T09:05:00.000Z"),
      buildSentMessage(3, "notice", "2026-09-25T09:06:00.000Z"),
    ];

    expect(chooseMessageStamps(messages, "UTC")).toEqual(["25 Sep 09:00", undefined, undefined]);
  });

  it("shares one separator between the owner's messages sent in the same minute", () => {
    const messages = [
      buildSentMessage(1, "owner", "2026-09-25T09:00:05.000Z"),
      buildSentMessage(2, "assistant", "2026-09-25T09:00:20.000Z"),
      buildSentMessage(3, "owner", "2026-09-25T09:00:40.000Z"),
      buildSentMessage(4, "owner", "2026-09-25T09:01:00.000Z"),
    ];

    expect(chooseMessageStamps(messages, "UTC")).toEqual([
      "25 Sep 09:00",
      undefined,
      undefined,
      "25 Sep 09:01",
    ]);
  });
});
