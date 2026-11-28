/** Tests how the gateway reads a client's message and chooses the revision of a handshake. */
import { describe, expect, it } from "vitest";
import { classifyMessage, negotiateStatefulRevision, readStatelessRevision } from "./protocol";

describe("classifyMessage", () => {
  it("tells a request from a notification, a response, a batch and nonsense", () => {
    expect(classifyMessage({ jsonrpc: "2.0", id: 1, method: "tools/list" })).toEqual({
      _tag: "request",
      id: 1,
      method: "tools/list",
      params: {},
    });
    expect(
      classifyMessage({ jsonrpc: "2.0", method: "notifications/initialized", params: { a: 1 } }),
    ).toEqual({ _tag: "notification", method: "notifications/initialized", params: { a: 1 } });
    expect(classifyMessage({ jsonrpc: "2.0", id: "x", result: {} })._tag).toBe("response");
    expect(classifyMessage([{ jsonrpc: "2.0", id: 1, method: "ping" }])._tag).toBe("batch");
    expect(classifyMessage({ hello: "world" })._tag).toBe("invalid");
    expect(classifyMessage("ping")._tag).toBe("invalid");
  });
});

describe("negotiateStatefulRevision", () => {
  it("answers a revision the gateway offers with itself and any other with the newest", () => {
    expect(negotiateStatefulRevision("2025-03-26")).toBe("2025-03-26");
    expect(negotiateStatefulRevision("2025-06-18")).toBe("2025-06-18");
    expect(negotiateStatefulRevision("2024-11-05")).toBe("2025-11-25");
    expect(negotiateStatefulRevision("2030-01-01")).toBe("2025-11-25");
    expect(negotiateStatefulRevision(undefined)).toBe("2025-11-25");
  });
});

describe("readStatelessRevision", () => {
  it("reads the revision a request names in its _meta", () => {
    expect(
      readStatelessRevision({ _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28" } }),
    ).toBe("2026-07-28");
    expect(readStatelessRevision({})).toBeUndefined();
    expect(readStatelessRevision({ _meta: "x" })).toBeUndefined();
  });
});
