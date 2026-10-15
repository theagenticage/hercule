/**
 * Tests `decideReplyPresentation(message)`: a quiet heartbeat reply collapses
 * to one line, a reply to a wake is labelled with the wake, and any other
 * reply is drawn as it always was.
 */
import { describe, expect, it } from "vitest";
import { decideReplyPresentation } from "./wake";

describe("decideReplyPresentation", () => {
  it("collapses a quiet heartbeat reply with nothing left over, with nothing to expand", () => {
    expect(decideReplyPresentation({ text: "", wake: "heartbeat", quiet: true })).toEqual({
      kind: "quiet",
      summary: "Heartbeat - nothing to report",
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
      summary: "Heartbeat - nothing to report",
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
