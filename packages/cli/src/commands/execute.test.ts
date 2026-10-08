import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@hercule/client-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { UsageError } from "../exit";
import { buildErrorEnvelope, buildId, stubFetch, type Handler } from "../testing";
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
  runId: null,
  stepId: null,
  instanceId: buildId("eeeeeeee"),
  runnerId: buildId("ffffffff"),
  workspaceId: null,
  projectId: null,
  requestedAccessMode: "approval-required",
  accessMode: "approval-required",
  nativeSessionId: null,
  modelSelection: { model: "claude-opus-4", options: {} },
  parentSessionId: null,
  openRequests: [],
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
  attachments: [],
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

/** Returns a subagent of `sessionId`, as `session subagent list` returns it. */
const buildSubagent = (id: string, sessionId: string) => ({
  id,
  sessionId,
  status: "running",
  toolCalls: 0,
  startedAt: "2026-09-15T10:00:00.000Z",
});

/**
 * `--subagent` is matched among the subagents of the session the command
 * names: the list is read with the command's own session id, so a tail never
 * matches another session's subagent.
 */
describe("a flag resolved within the command's own session", () => {
  const session = buildSession("eeeeeee5");
  const SUBAGENTS = [
    buildSubagent("agent-a1b2c3d4e5f6", session.id),
    buildSubagent("agent-ffff0000c3d4e5f6", session.id),
    buildSubagent("b7", session.id),
  ];

  /** Answers the session's subagent list, and the transcript with no rows. */
  const stubSubagents = () =>
    stubClient((request) =>
      request.path === `/api/v1/sessions/${session.id}/subagents`
        ? { items: SUBAGENTS }
        : { items: [] },
    );

  const readTranscript = async (subagent: string) => {
    const { fetch, client } = stubSubagents();
    const command = lookUpCommand("transcript", "read");
    const args = await parseArguments(
      command,
      [session.id, "--subagent", subagent],
      refuseStdinRead,
    );
    return { fetch, run: () => execute(client, command, args) };
  };

  it("reads the session's subagents and sends the full id of the one a tail names", async () => {
    const { fetch, run } = await readTranscript("a1b2c3d4e5f6");

    await run();

    expect(fetch.calls[0]).toMatchObject({
      method: "GET",
      path: `/api/v1/sessions/${session.id}/subagents`,
    });
    expect(fetch.calls[1]?.path).toBe(`/api/v1/sessions/${session.id}/transcript`);
    expect(fetch.calls[1]?.query.get("subagentId")).toBe("agent-a1b2c3d4e5f6");
  });

  it("accepts a full id, even one shorter than a tail", async () => {
    const { fetch, run } = await readTranscript("b7");

    await run();

    expect(fetch.calls[1]?.query.get("subagentId")).toBe("b7");
  });

  it("fails with conflict, listing the whole ids, when a tail matches two subagents", async () => {
    const { fetch, run } = await readTranscript("c3d4e5f6");

    await expect(run()).rejects.toMatchObject({
      code: "conflict",
      message: "c3d4e5f6 matches 2 subagent ids: agent-a1b2c3d4e5f6, agent-ffff0000c3d4e5f6",
    });
    expect(fetch.calls).toHaveLength(1);
  });

  /**
   * A subagent's id is the harness's own and not canonical, so the CLI cannot
   * tell a whole id from a tail, and the message reads true for both.
   */
  it("fails with not_found, for a whole id as for a tail, when no subagent of the session matches", async () => {
    for (const text of ["99999999", "agent-nope00000000"]) {
      const { fetch, run } = await readTranscript(text);

      await expect(run()).rejects.toMatchObject({
        code: "not_found",
        message: `no subagent has the id ${text} or an id ending with it`,
      });
      expect(fetch.calls).toHaveLength(1);
    }
  });

  it("fails with a usage error for short text that is no subagent's id", async () => {
    const { fetch, run } = await readTranscript("a1b2");

    await expect(run()).rejects.toThrow(UsageError);
    expect(fetch.calls).toHaveLength(1);
  });

  it("reads the subagents of the session a tail names, once the session is resolved", async () => {
    const { fetch, client } = stubClient((request) =>
      request.path === "/api/v1/sessions"
        ? { items: [session] }
        : request.path === `/api/v1/sessions/${session.id}/subagents`
          ? { items: SUBAGENTS }
          : session,
    );
    const command = lookUpCommand("session", "interrupt");
    const args = await parseArguments(
      command,
      ["0eeeeeee5", "--subagent", "a1b2c3d4e5f6"],
      refuseStdinRead,
    );

    await execute(client, command, args);

    expect(fetch.calls.map((call) => call.path)).toEqual([
      "/api/v1/sessions",
      `/api/v1/sessions/${session.id}/subagents`,
      `/api/v1/sessions/${session.id}/interrupt`,
    ]);
    expect(fetch.calls[2]?.body).toEqual({ subagentId: "agent-a1b2c3d4e5f6" });
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

/**
 * A session parked on a question is answered with `--answers`, a JSON object
 * from each question's header to the answer.
 */
describe("session respond-to-question", () => {
  const row = buildSession("ddddddd4");

  it("sends --answers as an answers object", async () => {
    const { fetch, client } = stubClient(() => row);
    const command = lookUpCommand("session", "respond-to-question");
    const args = await parseArguments(
      command,
      [row.id, "--request", "req-1", "--answers", '{"Storage":"localStorage"}'],
      refuseStdinRead,
    );

    await execute(client, command, args);

    expect(fetch.calls).toHaveLength(1);
    expect(fetch.calls[0]).toMatchObject({
      method: "POST",
      path: `/api/v1/sessions/${row.id}/respond-to-question`,
    });
    expect(fetch.calls[0]?.body).toEqual({
      requestId: "req-1",
      answers: { Storage: "localStorage" },
    });
  });
});

// Tests that `--image` uploads each file and sends the returned ids.
describe("an upload field", () => {
  const command = lookUpCommand("session", "input");
  const sessionId = buildId("ccccccc3");
  let directory: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "hercule-cli-images-"));
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  /** Writes a file into the test's directory and returns its path. */
  const writeImage = (name: string, content: string | Uint8Array): string => {
    const path = join(directory, name);
    writeFileSync(path, content);
    return path;
  };

  /** Answers each upload with the next id, and the input with its outcome. */
  const answerUploads = (ids: ReadonlyArray<string>): Handler => {
    let uploaded = 0;
    return (request) =>
      request.path === "/api/v1/attachments"
        ? Response.json(
            {
              id: ids[uploaded++],
              name: request.query.get("name"),
              mimeType: "image/png",
              sizeBytes: 4,
            },
            { status: 201 },
          )
        : { inputId: buildId("ddddddd4"), result: "queued" };
  };

  it("uploads each file in order, then sends the ids in the same order", async () => {
    const second = writeImage("second.png", "BBBB");
    const first = writeImage("first.png", "AAAA");
    const ids = [buildId("eeeeeee5"), buildId("fffffff6")];
    const { fetch, client } = stubClient(answerUploads(ids));
    const args = await parseArguments(
      command,
      [sessionId, "--image", second, "--image", first],
      () => Promise.resolve("Compare these."),
    );

    await execute(client, command, args);

    expect(fetch.calls.map((call) => [call.method, call.path, call.query.get("name")])).toEqual([
      ["POST", "/api/v1/attachments", "second.png"],
      ["POST", "/api/v1/attachments", "first.png"],
      ["POST", `/api/v1/sessions/${sessionId}/input`, null],
    ]);
    expect(fetch.calls[0]!.body).toBe("BBBB");
    expect(fetch.calls[2]!.body).toEqual({ text: "Compare these.", attachments: ids });
  });

  it("refuses a file it cannot read before sending anything", async () => {
    const { fetch, client } = stubClient(answerUploads([]));
    const args = await parseArguments(
      command,
      [sessionId, "--image", join(directory, "missing.png")],
      () => Promise.resolve("x"),
    );

    const failure = execute(client, command, args);
    await expect(failure).rejects.toBeInstanceOf(UsageError);
    await expect(failure).rejects.toThrow(/--image: .*missing\.png does not exist/);
    expect(fetch.calls).toEqual([]);
  });

  it("refuses more images than one input carries before sending anything", async () => {
    const path = writeImage("a.png", "AAAA");
    const { fetch, client } = stubClient(answerUploads([]));
    const args = await parseArguments(
      command,
      [sessionId, ...Array.from({ length: 11 }, () => ["--image", path]).flat()],
      () => Promise.resolve("x"),
    );

    await expect(execute(client, command, args)).rejects.toThrow(
      "--image: 11 images given, but one input carries at most 10",
    );
    expect(fetch.calls).toEqual([]);
  });

  it("refuses a file whose name is not an accepted image type before sending anything", async () => {
    const path = writeImage("notes.txt", "plain text");
    const { fetch, client } = stubClient(answerUploads([]));
    const args = await parseArguments(command, [sessionId, "--image", path], () =>
      Promise.resolve("x"),
    );

    await expect(execute(client, command, args)).rejects.toThrow(
      /--image: ".*notes\.txt" is not an image Hercule can send/,
    );
    expect(fetch.calls).toEqual([]);
  });

  it("refuses a file larger than an upload accepts before sending anything", async () => {
    const path = writeImage("huge.png", new Uint8Array(10 * 1024 * 1024 + 1));
    const { fetch, client } = stubClient(answerUploads([]));
    const args = await parseArguments(command, [sessionId, "--image", path], () =>
      Promise.resolve("x"),
    );

    await expect(execute(client, command, args)).rejects.toThrow(
      /huge\.png" is 10\.0 MB; an image can be up to 10\.0 MB\./,
    );
    expect(fetch.calls).toEqual([]);
  });

  it("names the file in the controller's refusal of an upload", async () => {
    const path = writeImage("notes.png", "plain text");
    const { client } = stubClient(() =>
      buildErrorEnvelope("validation", 400, "This file is not a PNG, JPEG, GIF or WebP image.", {
        issues: [],
      }),
    );
    const args = await parseArguments(command, [sessionId, "--image", path], () =>
      Promise.resolve("x"),
    );

    await expect(execute(client, command, args)).rejects.toThrow(
      `--image ${path}: This file is not a PNG, JPEG, GIF or WebP image.`,
    );
  });
});
