/**
 * Tests `hercule github-token` against a real Unix socket. What the client
 * prints and its exit code are all the `gh` shim sees.
 */
import { createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runGithubToken } from "./github-token-client";
import { cleanTemporaries, createTemporaryDir } from "../workspaces/testing";

afterAll(cleanTemporaries);

const stdout = vi.spyOn(process.stdout, "write");
const stderr = vi.spyOn(process.stderr, "write");
beforeEach(() => {
  stdout.mockReturnValue(true);
  stderr.mockReturnValue(true);
  process.exitCode = undefined;
});
afterEach(() => {
  vi.clearAllMocks();
  process.exitCode = undefined;
});

const servers: Server[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.close();
});

/** Starts a socket server that handles each connection with `onRequest`, and returns its path. */
const serve = async (onRequest: (request: string, socket: Socket) => void): Promise<string> => {
  const path = join(createTemporaryDir("hercule-github-token-"), "daemon.sock");
  const server = createServer((socket) => {
    let received = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      received += chunk;
      if (received.includes("\n")) onRequest(received, socket);
    });
    // The client destroys its end as soon as it has what it needs.
    socket.on("error", () => undefined);
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(path, resolve));
  return path;
};

const printed = (): { out: string; err: string } => ({
  out: stdout.mock.calls.map(([chunk]) => String(chunk)).join(""),
  err: stderr.mock.calls.map(([chunk]) => String(chunk)).join(""),
});

describe("hercule github-token", () => {
  it("prints the token the runner answers with, asking with the session's own token", async () => {
    let asked = "";
    const path = await serve((request, socket) => {
      asked = request;
      socket.write('{"token":"ghp_fresh"}\n');
    });

    await runGithubToken({ HERCULE_RUNNER_SOCKET: path, HERCULE_TOKEN: "session-token" });

    expect(JSON.parse(asked)).toEqual({ kind: "githubToken", sessionToken: "session-token" });
    expect(printed()).toEqual({ out: "ghp_fresh\n", err: "" });
    expect(process.exitCode).toBeUndefined();
  });

  it("prints the runner's reason as one line on stderr and fails", async () => {
    const path = await serve((_request, socket) =>
      socket.write('{"reason":"the Connection \'work\' needs reconnecting"}\n'),
    );

    await runGithubToken({ HERCULE_RUNNER_SOCKET: path, HERCULE_TOKEN: "session-token" });

    expect(printed()).toEqual({
      out: "",
      err: "hercule: no fresh GitHub token (the Connection 'work' needs reconnecting)\n",
    });
    expect(process.exitCode).toBe(1);
  });

  it.each([
    ["the socket variable", { HERCULE_TOKEN: "session-token" }],
    ["the session token", { HERCULE_RUNNER_SOCKET: "/nowhere.sock" }],
  ])("fails without connecting when %s is missing", async (_name, env) => {
    await runGithubToken(env);

    expect(printed()).toEqual({
      out: "",
      err: "hercule: no fresh GitHub token (not in a Hercule session)\n",
    });
    expect(process.exitCode).toBe(1);
  });

  it("fails when no runner listens on the socket", async () => {
    const path = join(createTemporaryDir("hercule-github-token-"), "gone.sock");

    await runGithubToken({ HERCULE_RUNNER_SOCKET: path, HERCULE_TOKEN: "session-token" });

    expect(printed()).toEqual({
      out: "",
      err: "hercule: no fresh GitHub token (the runner could not be reached)\n",
    });
    expect(process.exitCode).toBe(1);
  });

  it("fails when the runner does not answer within the deadline", async () => {
    const path = await serve(() => undefined);

    await runGithubToken({ HERCULE_RUNNER_SOCKET: path, HERCULE_TOKEN: "session-token" }, 50);

    expect(printed()).toEqual({
      out: "",
      err: "hercule: no fresh GitHub token (the runner did not answer in time)\n",
    });
    expect(process.exitCode).toBe(1);
  });
});
