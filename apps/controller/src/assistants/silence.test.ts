import { describe, expect, it } from "vitest";
import { applyHeartbeatSilenceRule } from "./silence";

describe("applyHeartbeatSilenceRule", () => {
  it("returns text without NO_REPLY unchanged and not quiet", () => {
    expect(applyHeartbeatSilenceRule("  Rain tomorrow.  ")).toEqual({
      text: "  Rain tomorrow.  ",
    });
  });

  it("recognizes NO_REPLY alone as quiet with empty text", () => {
    expect(applyHeartbeatSilenceRule("  NO_REPLY\n")).toEqual({ text: "", quiet: true });
  });

  it("strips NO_REPLY at the start", () => {
    expect(applyHeartbeatSilenceRule("NO_REPLY nothing new")).toEqual({
      text: "nothing new",
      quiet: true,
    });
  });

  it("strips NO_REPLY at the end", () => {
    expect(applyHeartbeatSilenceRule("nothing new\n\nNO_REPLY\n")).toEqual({
      text: "nothing new",
      quiet: true,
    });
  });

  it("strips NO_REPLY at both ends", () => {
    expect(applyHeartbeatSilenceRule("NO_REPLY nothing new NO_REPLY")).toEqual({
      text: "nothing new",
      quiet: true,
    });
  });

  it("does not recognize NO_REPLY in the middle of the text", () => {
    const text = "I could say NO_REPLY here but will not";
    expect(applyHeartbeatSilenceRule(text)).toEqual({ text });
  });

  it("is quiet with 299 characters left and not quiet with 300", () => {
    expect(applyHeartbeatSilenceRule(`NO_REPLY ${"a".repeat(299)}`)).toEqual({
      text: "a".repeat(299),
      quiet: true,
    });
    expect(applyHeartbeatSilenceRule(`${"a".repeat(300)} NO_REPLY`)).toEqual({
      text: "a".repeat(300),
    });
  });
});
