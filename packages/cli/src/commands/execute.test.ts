import { createClient } from "@hercule/client-core";
import { describe, expect, it } from "vitest";
import { UsageError } from "../exit";
import { buildId, stubFetch, type Handler } from "../testing";
import { parseArguments } from "./args";
import { execute } from "./execute";
import { findCommandByWords } from "./tree";

const lookUpCommand = (...words: ReadonlyArray<string>) => findCommandByWords(words)!;
const refuseStdinRead = () => Promise.reject(new Error("stdin was read"));

const stubClient = (handler: Handler) => {
  const fetch = stubFetch(handler);
  const client = createClient({ baseUrl: "http://controller.test", token: "t", fetch });
  return { fetch, client };
};

/** Returns a join token, as `runner join-token list` returns it. */
const joinToken = (tail: string) => ({
  id: buildId(tail),
  createdAt: "2026-09-15T10:00:00.000Z",
  expiresAt: "2026-09-15T11:00:00.000Z",
});

/** Returns a session, as `session list` returns it. */
const buildSession = (tail: string) => ({
  id: buildId(tail),
  title: "a thread",
  status: "idle",
  resumable: false,
  resumeHeld: false,
  permissionProfileId: buildId("dddddddd"),
  agentId: null,
  conversationId: null,
  instanceId: buildId("eeeeeeee"),
  runnerId: buildId("ffffffff"),
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
  unenforced: [],
});

const buildInput = (inputId: string, sessionId: string) => ({
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

// Tests how a tail is resolved through the list operation a row's `resolves` names.
describe("a positional whose row resolves tails", () => {
  it("reads the list the row names, then calls the operation with the full id", async () => {
    const token = joinToken("aaaaaaa1");
    const { fetch, client } = stubClient((request) =>
      request.path === "/api/v1/runners/join-tokens" && request.method === "GET" ? [token] : {},
    );
    const command = lookUpCommand("runner", "join-token", "revoke");
    const args = await parseArguments(command, ["0aaaaaaa1"], refuseStdinRead);

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
    const row = buildSession("bbbbbbb2");
    const inputId = "0193f3a9-2e5c-7b41-9a6d-1f3a9c2e77b0";
    const { fetch, client } = stubClient((request) =>
      request.path === "/api/v1/sessions" && request.method === "GET"
        ? { items: [row] }
        : buildInput(inputId, row.id),
    );
    const command = lookUpCommand("input", "update");
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
 * A field whose schema is a struct, or a union of structs, is given as JSON on
 * the command line, the only way to write a nested value in a terminal. The
 * request gets the parsed object, not the text.
 */
describe("a flag for a structured field", () => {
  it("sends a workspace flag's JSON as an object", async () => {
    const row = buildSession("ccccccc3");
    const { fetch, client } = stubClient(() => row);
    const command = lookUpCommand("session", "spawn");
    const workspace = {
      kind: "ephemeral",
      checkouts: [{ resourceId: buildId("11111111"), baseBranch: "main" }],
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

  it("rejects a workspace that is not JSON, naming the flag, and calls nothing", async () => {
    const { fetch } = stubClient(() => ({}));
    const command = lookUpCommand("session", "spawn");

    await expect(
      parseArguments(command, ["--workspace", "ephemeral"], () => Promise.resolve("go\n")),
    ).rejects.toThrow(/--workspace: ephemeral is not valid JSON/);
    expect(fetch.calls).toEqual([]);
  });
});

describe("a field whose row does not resolve tails", () => {
  it("rejects a tail for a Hercule id, asks for the full id, and calls nothing", async () => {
    const { fetch, client } = stubClient(() => ({}));
    // A queued input's id: a Hercule id with no list operation, so a tail
    // cannot be looked up and is rejected rather than sent.
    const command = lookUpCommand("input", "update");
    const args = await parseArguments(
      command,
      ["1f3a9c2e-0000-7000-8000-000000000001", "1f3a9c2e"],
      () => Promise.resolve("try again\n"),
    );

    await expect(execute(client, command, args)).rejects.toThrow(UsageError);
    await expect(execute(client, command, args)).rejects.toThrow(/full id/);
    expect(fetch.calls).toEqual([]);
  });

  it("sends a plugin id as written, because a plugin id is never a tail", async () => {
    const { fetch, client } = stubClient(() => ({}));
    // It looks like hex, but it is a name: plugin ids are not Hercule ids, so
    // there is no longer id this could be the end of.
    const command = lookUpCommand("plugin", "read");
    const args = await parseArguments(command, ["1f3a9c2e"], refuseStdinRead);

    await execute(client, command, args).catch(() => undefined);
    expect(fetch.calls[0]?.path).toBe("/api/v1/plugins/1f3a9c2e");
  });

  it("still accepts a plugin's real id", async () => {
    const { fetch, client } = stubClient(() => ({}));
    const command = lookUpCommand("plugin", "enable");
    const args = await parseArguments(command, ["github"], refuseStdinRead);

    await execute(client, command, args).catch(() => undefined);
    expect(fetch.calls[0]?.path).toBe("/api/v1/plugins/github/enable");
  });
});
