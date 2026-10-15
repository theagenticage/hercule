/**
 * Tests `decideReplyPresentation(message)`: a quiet heartbeat reply collapses
 * to one line, consecutive ones fold into one, a reply to a wake is labelled with the wake, and any other
 * reply is drawn as it always was.
 */
import { describe, expect, it } from "vitest";
import type { ConversationMessage } from "@hercule/contract";
import { decideReplyPresentation, findRowIdOfMessage, groupQuietReplies } from "./wake";

describe("decideReplyPresentation", () => {
  it("collapses a quiet heartbeat reply with nothing left over, with nothing to expand", () => {
    expect(decideReplyPresentation({ text: "", wake: "heartbeat", quiet: true })).toEqual({
      kind: "quiet",
      summary: "Heartbeat · nothing to report",
      detail: null,
    });
  });

  it("treats a quiet reply whose text is only whitespace as having nothing to expand", () => {
    expect(decideReplyPresentation({ text: " \n", wake: "heartbeat", quiet: true })).toMatchObject({
      kind: "quiet",
      detail: null,
    });
  });

  it("keeps what the assistant wrote besides NO_REPLY as the detail", () => {
    expect(
      decideReplyPresentation({ text: "Checked the queue.", wake: "heartbeat", quiet: true }),
    ).toEqual({
      kind: "quiet",
      summary: "Heartbeat · a short note",
      detail: "Checked the queue.",
    });
  });

  it("labels a reply to a heartbeat or a reminder with the wake", () => {
    expect(decideReplyPresentation({ text: "The run failed.", wake: "heartbeat" })).toEqual({
      kind: "labelled",
      label: "Heartbeat",
    });
    expect(decideReplyPresentation({ text: "Chase Acme.", wake: "reminder" })).toEqual({
      kind: "labelled",
      label: "Reminder",
    });
  });

  it("draws a reply no wake opened as a plain reply", () => {
    expect(decideReplyPresentation({ text: "Hello." })).toEqual({ kind: "plain" });
  });
});

const message = (
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

const quiet = (id: string, createdAt: string, text = ""): ConversationMessage =>
  message(id, createdAt, { wake: "heartbeat", quiet: true, text });

describe("groupQuietReplies", () => {
  it("folds consecutive quiet replies into one line with the span of their times", () => {
    const lines = groupQuietReplies(
      [
        quiet("m1", "2026-10-16T10:00:00Z"),
        quiet("m2", "2026-10-16T11:00:00Z"),
        quiet("m3", "2026-10-16T12:00:00Z"),
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
    const [line] = groupQuietReplies([quiet("m1", "2026-10-16T10:00:00Z")], "UTC");
    expect(line).toMatchObject({
      run: { summary: "Heartbeat · nothing to report", span: "10:00" },
    });
    expect(line?.kind === "quiet-run" && line.run.beats[0]?.sessionId).toBe("s-m1");
  });

  it("counts the replies that carry a note without hiding them", () => {
    const [line] = groupQuietReplies(
      [quiet("m1", "2026-10-16T10:00:00Z"), quiet("m2", "2026-10-16T11:00:00Z", "Queue is long.")],
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
        quiet("m1", "2026-10-16T10:00:00Z"),
        message("m2", "2026-10-16T10:30:00Z", { text: "Hi." }),
        quiet("m3", "2026-10-16T11:00:00Z"),
        quiet("m4", "2026-10-16T12:00:00Z"),
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
      [quiet("m1", "2026-10-16T23:00:00Z"), quiet("m2", "2026-10-17T00:00:00Z")],
      "UTC",
    );
    expect(lines.map((line) => line.stamp)).toEqual(["16 Oct", "17 Oct"]);
  });

  it("gives a message the stamp chooseMessageStamps picks", () => {
    const [line] = groupQuietReplies(
      [message("m1", "2026-10-16T10:00:00Z", { senderRole: "owner", text: "Hi" })],
      "UTC",
    );
    expect(line).toMatchObject({ kind: "message", stamp: "16 Oct 10:00" });
  });
});

describe("findRowIdOfMessage", () => {
  it("finds a message that is its own line, and one inside a quiet run by the run's first beat", () => {
    const lines = groupQuietReplies(
      [
        message("m1", "2026-10-16T09:00:00Z", { senderRole: "owner" }),
        quiet("m2", "2026-10-16T10:00:00Z"),
        quiet("m3", "2026-10-16T11:00:00Z"),
      ],
      "UTC",
    );
    expect(findRowIdOfMessage(lines, "m1")).toBe("m1");
    expect(findRowIdOfMessage(lines, "m2")).toBe("m2");
    expect(findRowIdOfMessage(lines, "m3")).toBe("m2");
    expect(findRowIdOfMessage(lines, "m9")).toBeUndefined();
  });
});
