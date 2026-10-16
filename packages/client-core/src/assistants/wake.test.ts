/**
 * Tests `chooseWakeLabel(message)`, `groupQuietReplies(messages, timezone)`
 * and `findRowIdOfMessage(lines, id)`: a reply to a wake is labelled with the
 * wake, consecutive quiet heartbeat replies fold into one line, and any other
 * reply is drawn as it always was.
 */
import { describe, expect, it } from "vitest";
import type { ConversationMessage } from "@hercule/contract";
import { chooseWakeLabel, findRowIdOfMessage, groupQuietReplies } from "./wake";

describe("chooseWakeLabel", () => {
  it.each([
    ["a heartbeat", { wake: "heartbeat" } as const, "Heartbeat"],
    ["a reminder", { wake: "reminder" } as const, "Reminder"],
    ["no wake", {}, undefined],
    [
      "a quiet heartbeat, which folds into a run instead",
      { wake: "heartbeat", quiet: true } as const,
      undefined,
    ],
  ])("labels a reply to %s", (_name, message, label) => {
    expect(chooseWakeLabel(message)).toBe(label);
  });
});

const buildConversationMessage = (
  id: string,
  createdAt: string,
  fields: Partial<ConversationMessage> = {},
): ConversationMessage => ({
  id,
  conversationId: "conv-1",
  containerKey: null,
  turnId: null,
  itemId: null,
  actor: "session:s1",
  position: Number(id.replace("m", "")),
  senderRole: "assistant",
  senderLabel: "Hercule",
  text: "",
  createdAt,
  sessionId: `s-${id}`,
  ...fields,
});

const buildQuietHeartbeatReply = (id: string, createdAt: string, text = ""): ConversationMessage =>
  buildConversationMessage(id, createdAt, { wake: "heartbeat", quiet: true, text });

describe("groupQuietReplies", () => {
  it("folds consecutive quiet replies into one line with the span of their times", () => {
    const lines = groupQuietReplies(
      [
        buildQuietHeartbeatReply("m1", "2026-10-16T10:00:00Z"),
        buildQuietHeartbeatReply("m2", "2026-10-16T11:00:00Z"),
        buildQuietHeartbeatReply("m3", "2026-10-16T12:00:00Z"),
      ],
      "UTC",
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      kind: "quiet-run",
      stamp: "16 Oct",
      run: {
        key: "quiet:m1",
        summary: "3 heartbeats · nothing to report",
        span: "10:00-12:00",
      },
    });
  });

  it("keeps a single quiet reply as its own line with one time and its session", () => {
    const [line] = groupQuietReplies(
      [buildQuietHeartbeatReply("m1", "2026-10-16T10:00:00Z")],
      "UTC",
    );
    expect(line).toMatchObject({
      run: { summary: "Heartbeat · nothing to report", span: "10:00" },
    });
    expect(line?.kind === "quiet-run" && line.run.beats[0]?.sessionId).toBe("s-m1");
  });

  it.each([
    ["no text", "", "Heartbeat · nothing to report"],
    ["text that is only whitespace", " \n", "Heartbeat · nothing to report"],
    ["a note", "Checked the queue.", "Heartbeat · a short note"],
  ])("says whether a single quiet reply with %s carries a note", (_name, text, summary) => {
    const [line] = groupQuietReplies(
      [buildQuietHeartbeatReply("m1", "2026-10-16T10:00:00Z", text)],
      "UTC",
    );
    expect(line).toMatchObject({ run: { summary } });
  });

  it("counts the replies that carry a note without hiding them", () => {
    const [line] = groupQuietReplies(
      [
        buildQuietHeartbeatReply("m1", "2026-10-16T10:00:00Z"),
        buildQuietHeartbeatReply("m2", "2026-10-16T11:00:00Z", "Queue is long."),
      ],
      "UTC",
    );
    expect(line).toMatchObject({ run: { summary: "2 heartbeats · 1 with a note" } });
    expect(line?.kind === "quiet-run" && line.run.beats.map((beat) => beat.note)).toEqual([
      null,
      "Queue is long.",
    ]);
  });

  it("ends a run at any other message and starts another after it", () => {
    const lines = groupQuietReplies(
      [
        buildQuietHeartbeatReply("m1", "2026-10-16T10:00:00Z"),
        buildConversationMessage("m2", "2026-10-16T10:30:00Z", { text: "Hi." }),
        buildQuietHeartbeatReply("m3", "2026-10-16T11:00:00Z"),
        buildQuietHeartbeatReply("m4", "2026-10-16T12:00:00Z"),
      ],
      "UTC",
    );
    expect(lines.map((line) => line.kind)).toEqual(["quiet-run", "message", "quiet-run"]);
    // The second run is on the same day as the message before it, so it
    // needs no day above it.
    expect(lines[2]?.stamp).toBeUndefined();
  });

  it("ends a run at midnight and names the new day above the next run", () => {
    const lines = groupQuietReplies(
      [
        buildQuietHeartbeatReply("m1", "2026-10-16T23:00:00Z"),
        buildQuietHeartbeatReply("m2", "2026-10-17T00:00:00Z"),
      ],
      "UTC",
    );
    expect(lines.map((line) => line.stamp)).toEqual(["16 Oct", "17 Oct"]);
  });

  it("gives a message the stamp chooseMessageStamps picks", () => {
    const [line] = groupQuietReplies(
      [buildConversationMessage("m1", "2026-10-16T10:00:00Z", { senderRole: "owner", text: "Hi" })],
      "UTC",
    );
    expect(line).toMatchObject({ kind: "message", stamp: "16 Oct 10:00" });
  });
});

describe("findRowIdOfMessage", () => {
  it("finds a message that is its own line, and one inside a quiet run by the run's first beat", () => {
    const lines = groupQuietReplies(
      [
        buildConversationMessage("m1", "2026-10-16T09:00:00Z", { senderRole: "owner" }),
        buildQuietHeartbeatReply("m2", "2026-10-16T10:00:00Z"),
        buildQuietHeartbeatReply("m3", "2026-10-16T11:00:00Z"),
      ],
      "UTC",
    );
    expect(findRowIdOfMessage(lines, "m1")).toBe("m1");
    expect(findRowIdOfMessage(lines, "m2")).toBe("m2");
    expect(findRowIdOfMessage(lines, "m3")).toBe("m2");
    expect(findRowIdOfMessage(lines, "m9")).toBeUndefined();
  });
});
