import { describe, expect, it } from "vitest";
import { buildDestinationKey } from "./destination";

describe("buildDestinationKey", () => {
  it("builds the same key for two equal destinations", () => {
    expect(buildDestinationKey({ kind: "thread", sessionId: "session-1" })).toBe(
      buildDestinationKey({ kind: "thread", sessionId: "session-1" }),
    );
  });

  it("builds different keys for a thread and an assistant with the same id", () => {
    expect(buildDestinationKey({ kind: "thread", sessionId: "same-id" })).not.toBe(
      buildDestinationKey({ kind: "assistant", assistantId: "same-id" }),
    );
  });

  it("builds different keys for two destinations of one kind", () => {
    expect(buildDestinationKey({ kind: "assistant", assistantId: "assistant-1" })).not.toBe(
      buildDestinationKey({ kind: "assistant", assistantId: "assistant-2" }),
    );
  });
});
