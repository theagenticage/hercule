import { MAX_MESSAGE_LENGTH } from "@hercule/protocol";
import { describe, expect, it } from "vitest";
import {
  buildHarnessNotInstalled,
  buildHarnessStartFailed,
  buildInputLost,
  buildInputRefused,
  buildModelChangeRefused,
} from "./adapter-error-builders";

const TOO_LONG = "x".repeat(MAX_MESSAGE_LENGTH * 2);

describe("the messages of the adapter error builders", () => {
  it("name the harness the user knows", () => {
    expect(buildHarnessNotInstalled("Claude Code")).toMatchObject({
      _tag: "HarnessNotInstalled",
      message: "Claude Code is not installed on this runner.",
    });
  });

  it("end the harness's text with a period, and keep it after the lead-in", () => {
    const refused = buildInputRefused("Codex", "the turn is busy");
    expect(refused._tag).toBe("InputNotDelivered");
    expect(refused.message).toBe("Codex refused the input: the turn is busy.");
    expect(buildInputRefused("Codex", "busy.").message).toBe("Codex refused the input: busy.");
  });

  it.each([
    ["buildHarnessStartFailed", () => buildHarnessStartFailed("pi", TOO_LONG)],
    ["buildInputRefused", () => buildInputRefused("pi", TOO_LONG)],
    ["buildInputLost", () => buildInputLost("pi", TOO_LONG)],
    ["buildModelChangeRefused", () => buildModelChangeRefused("pi", "change the model", TOO_LONG)],
  ])("%s cuts text longer than the protocol allows instead of throwing", (_name, build) => {
    expect(build().message.length).toBeLessThanOrEqual(MAX_MESSAGE_LENGTH);
  });
});
