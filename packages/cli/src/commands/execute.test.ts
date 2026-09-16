import { createClient } from "@hydra/client-core";
import { describe, expect, it } from "vitest";
import { UsageError } from "../exit";
import { id, stubFetch, type Handler } from "../testing";
import { parseArguments } from "./args";
import { execute } from "./execute";
import { commandAt } from "./tree";

const at = (...words: ReadonlyArray<string>) => commandAt(words)!;
const noStdin = () => Promise.reject(new Error("stdin was read"));

const wire = (handler: Handler) => {
  const fetch = stubFetch(handler);
  const client = createClient({ baseUrl: "http://controller.test", token: "t", fetch });
  return { fetch, client };
};

/** A join token reference, as `runner join-token list` answers with them. */
const joinToken = (tail: string) => ({
  id: id(tail),
  createdAt: "2026-09-15T10:00:00.000Z",
  expiresAt: "2026-09-15T11:00:00.000Z",
});

/** A session, as `session list` answers with them. */
const session = (tail: string) => ({
  id: id(tail),
  title: "a thread",
  status: "idle",
  resumable: false,
  permissionProfileId: id("dddddddd"),
  instanceId: id("eeeeeeee"),
  runnerId: id("ffffffff"),
  workspaceId: null,
  projectId: null,
  requestedAccessMode: "approval-required",
  accessMode: "approval-required",
  nativeSessionId: null,
  modelSelection: { model: "claude-opus-4", options: {} },
  parentSessionId: null,
  openRequest: null,
  createdAt: "2026-09-15T10:00:00.000Z",
  startedAt: null,
  exitedAt: null,
  lastActivityAt: "2026-09-15T10:00:00.000Z",
});

const input = (inputId: string, sessionId: string) => ({
  id: inputId,
  sessionId,
  source: "user",
  actor: "user",
  text: "Actually, start with the test that fails least often.",
  status: "queued",
  delivery: null,
  createdAt: "2026-09-15T10:00:00.000Z",
  deliveredAt: null,
  sentAt: null,
  reason: null,
});

// what the row's `resolves` does with a tail.
describe("a positional the row resolves", () => {
  it("sweeps the listing the row names, then acts on the full id", async () => {
    const token = joinToken("aaaaaaa1");
    const { fetch, client } = wire((request) =>
      request.path === "/api/v1/runners/join-tokens" && request.method === "GET" ? [token] : {},
    );
    const command = at("runner", "join-token", "revoke");
    const args = await parseArguments(command, ["0aaaaaaa1"], noStdin);

    await execute(client, command, args);

    expect(fetch.calls[0]).toMatchObject({
      method: "GET",
      path: "/api/v1/runners/join-tokens",
    });
    expect(fetch.calls[1]).toMatchObject({
      method: "DELETE",
      path: `/api/v1/runners/join-tokens/${token.id}`,
    });
    expect(fetch.calls.length).toBe(2);
  });

  it("resolves a session tail and sends the input id exactly as written", async () => {
    const row = session("bbbbbbb2");
    const inputId = "0193f3a9-2e5c-7b41-9a6d-1f3a9c2e77b0";
    const { fetch, client } = wire((request) =>
      request.path === "/api/v1/sessions" && request.method === "GET"
        ? { items: [row] }
        : input(inputId, row.id),
    );
    const command = at("input", "update");
    const args = await parseArguments(command, ["0bbbbbbb2", inputId], () =>
      Promise.resolve("Actually, start with the test that fails least often.\n"),
    );

    await execute(client, command, args);

    expect(fetch.calls[0]).toMatchObject({ method: "GET", path: "/api/v1/sessions" });
    expect(fetch.calls[1]).toMatchObject({
      method: "PATCH",
      path: `/api/v1/sessions/${row.id}/inputs/${inputId}`,
      body: { text: "Actually, start with the test that fails least often." },
    });
  });
});

/**
 * A field whose schema is a struct, or a union of them, is written as JSON on
 * the command line: the one way a terminal can spell a nested value. What the
 * flag holds reaches the request as the object it decodes to, not as text.
 */
describe("a flag over a structured field", () => {
  it("sends the JSON a workspace flag carries as the object it is", async () => {
    const row = session("ccccccc3");
    const { fetch, client } = wire(() => row);
    const command = at("session", "spawn");
    const workspace = {
      kind: "ephemeral",
      checkouts: [{ resourceId: id("11111111"), baseBranch: "main" }],
    };
    const args = await parseArguments(command, ["--workspace", JSON.stringify(workspace)], () =>
      Promise.resolve("Move the shared type over.\n"),
    );

    await execute(client, command, args);

    expect(fetch.calls[0]).toMatchObject({
      method: "POST",
      path: "/api/v1/sessions",
      body: { prompt: "Move the shared type over.", workspace },
    });
  });

  it("refuses a workspace that is not JSON, naming the flag, and calls nothing", async () => {
    const { fetch } = wire(() => ({}));
    const command = at("session", "spawn");

    await expect(
      parseArguments(command, ["--workspace", "ephemeral"], () => Promise.resolve("go\n")),
    ).rejects.toThrow(/--workspace: ephemeral is not valid JSON/);
    expect(fetch.calls).toEqual([]);
  });
});

describe("a positional the row does not resolve", () => {
  it("refuses a tail, names the full id, and calls nothing", async () => {
    const { fetch, client } = wire(() => ({}));
    const command = at("plugin", "read");
    const args = await parseArguments(command, ["1f3a9c2e"], noStdin);

    await expect(execute(client, command, args)).rejects.toThrow(UsageError);
    await expect(execute(client, command, args)).rejects.toThrow(/full id/);
    expect(fetch.calls).toEqual([]);
  });

  it("still takes the id a plugin actually has", async () => {
    const { fetch, client } = wire(() => ({}));
    const command = at("plugin", "enable");
    const args = await parseArguments(command, ["github"], noStdin);

    await execute(client, command, args).catch(() => undefined);
    expect(fetch.calls[0]?.path).toBe("/api/v1/plugins/github/enable");
  });
});
