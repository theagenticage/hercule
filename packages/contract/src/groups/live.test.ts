/**
 * Tests for the per-agent topic names: the session's own agent has
 * `session:<id>:stream` and `:tap`, and each subagent has its own pair with
 * `:subagent:<subagentId>` before the kind. The builders, the parser and the
 * schema must agree on every name, or a client would subscribe to a topic the
 * controller never publishes on.
 */
import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  buildSessionStreamTopic,
  buildSessionTapTopic,
  buildSubagentStreamTopic,
  buildSubagentTapTopic,
  isAppendOnlyLiveTopic,
  LiveTopic,
  parseSessionTopic,
} from "./live";

const isAccepted = (topic: string): boolean =>
  Schema.decodeUnknownExit(LiveTopic)(topic)._tag === "Success";

describe("a session topic", () => {
  it("parses back to the ids and kind it was built from", () => {
    expect(parseSessionTopic(buildSessionStreamTopic("s1"))).toEqual({
      sessionId: "s1",
      kind: "stream",
    });
    expect(parseSessionTopic(buildSessionTapTopic("s1"))).toEqual({ sessionId: "s1", kind: "tap" });
    expect(parseSessionTopic(buildSubagentStreamTopic("s1", "agent-a"))).toEqual({
      sessionId: "s1",
      subagentId: "agent-a",
      kind: "stream",
    });
    expect(parseSessionTopic(buildSubagentTapTopic("s1", "agent-a"))).toEqual({
      sessionId: "s1",
      subagentId: "agent-a",
      kind: "tap",
    });
  });

  it("is append-only and decodes, for the session's own agent and for a subagent", () => {
    for (const topic of [
      buildSessionStreamTopic("s1"),
      buildSessionTapTopic("s1"),
      buildSubagentStreamTopic("s1", "agent-a"),
      buildSubagentTapTopic("s1", "agent-a"),
    ]) {
      expect(isAccepted(topic), topic).toBe(true);
      expect(isAppendOnlyLiveTopic(topic), topic).toBe(true);
    }
  });

  it("refuses names that are not one agent's stream or tap", () => {
    for (const topic of [
      "session:s1",
      "session:s1:subagent:stream",
      "session:s1:subagent::stream",
      "session:s1:agent:agent-a:stream",
      "session:s1:subagent:a:b:tap",
    ]) {
      expect(parseSessionTopic(topic), topic).toBeUndefined();
      expect(isAccepted(topic), topic).toBe(false);
    }
  });

  it("leaves subagent as a mutable topic, refetched through the session", () => {
    expect(isAccepted("subagent")).toBe(true);
    expect(isAppendOnlyLiveTopic("subagent")).toBe(false);
  });
});
