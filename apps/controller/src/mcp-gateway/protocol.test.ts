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

describe("classifyMessage and a body that carries an id", () => {
  it("does not pass a message that has a method and an unreadable id for a notification", () => {
    for (const id of [null, {}, [1]]) {
      expect(classifyMessage({ jsonrpc: "2.0", method: "tools/list", id })._tag).toBe("invalid");
    }
  });
});

describe("checkStatelessMetadata", () => {
  const headers = { "mcp-protocol-version": "2026-07-28" };
  const notification = (
    method: string,
    params: Extract<IncomingMessage, { readonly method: string }>["params"] = {},
  ): Extract<IncomingMessage, { readonly method: string }> => ({
    _tag: "notification",
    method,
    params,
  });

  it("accepts any notification that carries no _meta, not only the ones the gateway knows", () => {
    for (const method of ["notifications/example/changed", "notifications/cancelled"]) {
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
    expect(refusal).toMatchObject({
      status: 400,
      code: -32602,
      message: "Required request metadata is missing",
    });
  });

  it("holds a notification to its method header", () => {
    expect(
      checkStatelessMetadata(
        { ...headers, "mcp-method": "tools/list" },
        notification("notifications/example/changed"),
      ),
    ).toMatchObject({ status: 400, code: -32020 });
  });

  it("holds a notification that names a revision to the version header", () => {
    const method = "notifications/example/changed";
    const withRevision = (revision: string) =>
      notification(method, { _meta: { "io.modelcontextprotocol/protocolVersion": revision } });
    expect(
      checkStatelessMetadata({ ...headers, "mcp-method": method }, withRevision("2026-07-28")),
    ).toBeUndefined();
    expect(
      checkStatelessMetadata({ ...headers, "mcp-method": method }, withRevision("2025-11-25")),
    ).toMatchObject({ status: 400, code: -32020 });
    expect(
      checkStatelessMetadata({ "mcp-method": method }, withRevision("2026-07-28")),
    ).toMatchObject({
      status: 400,
      code: -32020,
    });
    expect(
      checkStatelessMetadata(
        { "mcp-protocol-version": "2025-11-25", "mcp-method": method },
        withRevision("2025-11-25"),
      ),
    ).toMatchObject({ status: 400, code: -32022 });
  });
});
