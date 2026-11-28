/**
 * Tests `readWorkspaceThreads`: that it reads archived Threads too, and in
 * one read per `MAX_SESSION_WORKSPACE_IDS` workspaces.
 */
import { MAX_SESSION_WORKSPACE_IDS } from "@hercule/contract";
import { describe, expect, it } from "vitest";
import { createApiStub } from "../api-stub";
import { createClient } from "../client";
import { readWorkspaceThreads } from "./workspace-threads";

/** Returns the canonical id the client accepts for the thing numbered `number`. */
const uuid = (number: number): string =>
  `01a06d02-7400-7000-8000-${String(number).padStart(12, "0")}`;

describe("readWorkspaceThreads", () => {
  it("reads archived Threads too, in one read per 150 workspaces", async () => {
    const api = createApiStub({ "GET /api/v1/sessions": { body: { items: [] } } });
    const client = createClient({ baseUrl: "http://127.0.0.1:4937", fetch: api.fetch });
    const ids = Array.from({ length: MAX_SESSION_WORKSPACE_IDS + 1 }, (_, index) =>
      uuid(index + 1),
    );

    await readWorkspaceThreads(client, ids);

    const queries = api.calls.map((call) => new URLSearchParams(call.search));
    expect(queries.map((query) => query.getAll("workspaceId").length)).toEqual([
      MAX_SESSION_WORKSPACE_IDS,
      1,
    ]);
    expect(queries[0]!.get("kind")).toBe("thread");
    expect(queries[0]!.has("archived")).toBe(false);
  });
});
