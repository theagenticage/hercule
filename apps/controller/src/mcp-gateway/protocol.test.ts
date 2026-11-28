/** Tests how the gateway reads a client's message and chooses the revision of a handshake. */
import { describe, expect, it } from "vitest";
import {
  checkStatelessMetadata,
  classifyMessage,
  negotiateStatefulRevision,
  readStatelessRevision,
  type IncomingMessage,
} from "./protocol";

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

describe("checkStatelessMetadata", () => {
  const headers = { "mcp-protocol-version": "2026-07-28" };
  const revisionMeta = { "io.modelcontextprotocol/protocolVersion": "2026-07-28" };
  const notification = (
    method: string,
    params: Extract<IncomingMessage, { readonly method: string }>["params"] = {},
  ): Extract<IncomingMessage, { readonly method: string }> => ({
    _tag: "notification",
    method,
    params,
  });

  it("accepts a notification that carries no _meta, as agy sends notifications/roots/list_changed", () => {
    for (const method of ["notifications/roots/list_changed", "notifications/cancelled"]) {
      expect(
        checkStatelessMetadata({ ...headers, "mcp-method": method }, notification(method)),
      ).toBeUndefined();
    }
  });

  it("still refuses a request that carries no _meta", () => {
    const refusal = checkStatelessMetadata(
      { ...headers, "mcp-method": "tools/list" },
      { _tag: "request", id: 1, method: "tools/list", params: {} },
    );
    expect(refusal).toMatchObject({ status: 400, message: "Required request metadata is missing" });
  });

  it("holds a notification to the version header and to its own method header", () => {
    const method = "notifications/roots/list_changed";
    expect(checkStatelessMetadata({}, notification(method))?.message).toBe(
      "MCP-Protocol-Version header is required",
    );
    expect(checkStatelessMetadata(headers, notification(method))?.message).toBe(
      "Mcp-Method header does not match request method",
    );
    expect(
      checkStatelessMetadata(
        { "mcp-protocol-version": "2025-11-25", "mcp-method": method },
        notification(method),
      )?.message,
    ).toBe("Unsupported protocol version: 2025-11-25");
  });

  it("refuses a notification whose _meta names another revision than the header", () => {
    const method = "notifications/roots/list_changed";
    const refusal = checkStatelessMetadata(
      { ...headers, "mcp-method": method },
      notification(method, { _meta: { "io.modelcontextprotocol/protocolVersion": "2025-11-25" } }),
    );
    expect(refusal?.message).toBe("MCP-Protocol-Version header does not match request metadata");
    expect(
      checkStatelessMetadata(
        { ...headers, "mcp-method": method },
        notification(method, { _meta: revisionMeta }),
      ),
    ).toBeUndefined();
  });
});
