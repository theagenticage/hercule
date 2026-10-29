import { MAX_MESSAGE_LENGTH } from "@hercule/protocol";
import { describe, expect, it } from "vitest";
import {
  buildAdapterFailed,
  buildAnswerNotDelivered,
  buildHarnessNotInstalled,
  buildHarnessNotRunnable,
  buildHarnessProtocolError,
  buildInputLost,
  buildInputRefused,
  buildModelChangeRefused,
  buildStartFailure,
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

  it("tells the user that a harness that exists could not be run, and to check its PATH", () => {
    const failure = buildHarnessNotRunnable("pi", "spawn failed");
    expect(failure._tag).toBe("AdapterFailed");
    expect(failure.message).toContain("installed");
    expect(failure.message).toContain("PATH");
    expect(failure.message).toContain("spawn failed");
  });

  it.each([
    ["buildAdapterFailed", () => buildAdapterFailed(TOO_LONG)],
    ["buildHarnessProtocolError", () => buildHarnessProtocolError(TOO_LONG)],
    ["buildAnswerNotDelivered", () => buildAnswerNotDelivered(TOO_LONG)],
    ["buildStartFailure", () => buildStartFailure("pi", TOO_LONG)],
    ["buildHarnessNotRunnable", () => buildHarnessNotRunnable("pi", TOO_LONG)],
    ["buildInputRefused", () => buildInputRefused("pi", TOO_LONG)],
    ["buildInputLost", () => buildInputLost("pi", TOO_LONG)],
    ["buildModelChangeRefused", () => buildModelChangeRefused("pi", "change the model", TOO_LONG)],
  ])("%s cuts text longer than the protocol allows instead of throwing", (_name, build) => {
    expect(build().message.length).toBeLessThanOrEqual(MAX_MESSAGE_LENGTH);
  });
});
