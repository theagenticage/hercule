import { describe, expect, it } from "vitest";
import { applyHeartbeatSilenceRule } from "./silence";

describe("applyHeartbeatSilenceRule", () => {
  it.each([
    {
      when: "returns text without NO_REPLY unchanged and not quiet",
      text: "  Rain tomorrow.  ",
      result: { text: "  Rain tomorrow.  " },
    },
    {
      when: "recognizes NO_REPLY alone as quiet with empty text",
      text: "  NO_REPLY\n",
      result: { text: "", quiet: true },
    },
    {
      when: "strips NO_REPLY at the start",
      text: "NO_REPLY nothing new",
      result: { text: "nothing new", quiet: true },
    },
    {
      when: "strips NO_REPLY at the end",
      text: "nothing new\n\nNO_REPLY\n",
      result: { text: "nothing new", quiet: true },
    },
    {
      when: "strips NO_REPLY at both ends",
      text: "NO_REPLY nothing new NO_REPLY",
      result: { text: "nothing new", quiet: true },
    },
    {
      when: "does not recognize NO_REPLY in the middle of the text",
      text: "I could say NO_REPLY here but will not",
      result: { text: "I could say NO_REPLY here but will not" },
    },
    {
      when: "is quiet with 299 characters left",
      text: `NO_REPLY ${"a".repeat(299)}`,
      result: { text: "a".repeat(299), quiet: true },
    },
    {
      when: "is not quiet with 300 characters left",
      text: `${"a".repeat(300)} NO_REPLY`,
      result: { text: "a".repeat(300) },
    },
  ])("$when", ({ text, result }) => {
    expect(applyHeartbeatSilenceRule(text)).toEqual(result);
  });
});
