/**
 * Tests the runner's credential socket. The socket does not look up
 * credentials itself: it turns git's request into a request to the controller
 * and returns the answer. In every other case it replies empty, which lets git
 * move on to the machine's own helpers.
 */
import { existsSync, statSync } from "node:fs";
import { createConnection } from "node:net";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { CredentialAnswer } from "@hercule/protocol";
import type { GithubTokenResult } from "./github-tokens";
import { serveCredentialSocket } from "./index";
import { cleanTemporaries, createTemporaryDir } from "../workspaces/testing";

afterAll(cleanTemporaries);

const createSocketPath = (): string =>
  join(createTemporaryDir("hercule-credentials-"), "daemon.sock");

/** Builds a credential answer: either a credential or an error, never a mix of optional fields. */
const buildCredentialAnswer = (
  fields:
    | { readonly token: string; readonly username: string }
    | { readonly error: "unauthorized" | "no_connection" },
): CredentialAnswer => ({
  _tag: "credentialAnswer",
  requestId: crypto.randomUUID(),
  ...fields,
});

/** Sends one request over the socket the way the helper does, and returns the reply line. */
const askOverSocket = (path: string, request: Record<string, string>): Promise<string> =>
  new Promise((resolve, reject) => {
    const socket = createConnection({ path });
    let received = "";
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on("data", (chunk: string) => {
      received += chunk;
      if (received.includes("\n")) {
        socket.end();
        resolve(received);
      }
    });
    socket.on("end", () => {
      resolve(received);
    });
    socket.on("error", reject);
  });

const asked: Array<unknown> = [];

const startCredentialSocket = async (
  answer: (request: unknown) => Promise<CredentialAnswer>,
  readGithubToken: (sessionToken: string) => Promise<GithubTokenResult> = () =>
    Promise.reject(new Error("no GitHub token was expected")),
): Promise<{ path: string; close: () => Promise<void> }> => {
  const path = createSocketPath();
  const server = await serveCredentialSocket({
    path,
    ask: (request) => {
      asked.push(request);
      return answer(request);
    },
    readGithubToken,
  });
  return { path, close: () => server.close() };
};

describe("what the socket forwards", () => {
  it("asks the controller for git's remote, with the session's token", async () => {
    asked.length = 0;
    const served = await startCredentialSocket(() =>
      Promise.resolve(buildCredentialAnswer({ token: "the-token", username: "octocat" })),
    );

    const reply = await askOverSocket(served.path, {
      protocol: "https",
      host: "github.com",
      path: "acme/web",
      sessionToken: "the-session-token",
    });

    // The controller normalizes the remote; the token identifies the session.
    expect(asked).toEqual([{ remote: "github.com/acme/web", sessionToken: "the-session-token" }]);
    expect(JSON.parse(reply.trim())).toEqual({ username: "octocat", password: "the-token" });
    await served.close();
  });

  it("sends a workspace id instead for the runner's own git while it provisions", async () => {
    asked.length = 0;
    const served = await startCredentialSocket(() =>
      Promise.resolve(buildCredentialAnswer({ token: "the-token", username: "octocat" })),
    );

    await askOverSocket(served.path, {
      protocol: "https",
      host: "github.com",
      path: "acme/web",
      workspaceId: "0199e0e7-0000-7000-8000-00000000000b",
    });

    expect(asked).toEqual([
      { remote: "github.com/acme/web", workspaceId: "0199e0e7-0000-7000-8000-00000000000b" },
    ]);
    await served.close();
  });
});

describe("what the socket answers the gh shim", () => {
  const ask = (path: string, fields: Record<string, string> = { sessionToken: "the-session" }) =>
    askOverSocket(path, { kind: "githubToken", ...fields });

  it("returns the token held for the session, and does not ask git's question", async () => {
    asked.length = 0;
    const read: Array<string> = [];
    const served = await startCredentialSocket(
      () => Promise.reject(new Error("git was not asked")),
      (sessionToken) => {
        read.push(sessionToken);
        return Promise.resolve({ token: "ghs_the-token" });
      },
    );

    const reply = await ask(served.path);

    expect(JSON.parse(reply.trim())).toEqual({ token: "ghs_the-token" });
    expect(read).toEqual(["the-session"]);
    expect(asked).toEqual([]);
    await served.close();
  });

  it("returns the reason when there is no token, such as for a session it does not know", async () => {
    const served = await startCredentialSocket(
      () => Promise.reject(new Error("git was not asked")),
      () => Promise.resolve({ reason: "this runner holds no GitHub token for this session" }),
    );

    const reply = await ask(served.path, { sessionToken: "unknown-session" });

    expect(JSON.parse(reply.trim())).toEqual({
      reason: "this runner holds no GitHub token for this session",
    });
    await served.close();
  });

  it("returns a reason, and reads nothing, when the request has no session token", async () => {
    const read: Array<string> = [];
    const served = await startCredentialSocket(
      () => Promise.reject(new Error("git was not asked")),
      (sessionToken) => {
        read.push(sessionToken);
        return Promise.resolve({ token: "ghs_the-token" });
      },
    );

    const reply = await ask(served.path, {});

    expect(JSON.parse(reply.trim())).toEqual({ reason: "the request has no session token" });
    expect(read).toEqual([]);
    await served.close();
  });

  it.each([
    ["token", { token: "ghs_one\nGH_HOST=evil.example" }],
    ["reason", { reason: "line one\nline two" }],
  ])("never sends a %s with a line break, and gives a reason instead", async (_name, result) => {
    const served = await startCredentialSocket(
      () => Promise.reject(new Error("git was not asked")),
      () => Promise.resolve(result),
    );

    const reply = await ask(served.path);

    const answer = JSON.parse(reply.trim()) as Record<string, string>;
    expect(Object.keys(answer)).toEqual(["reason"]);
    expect(answer["reason"]).not.toMatch(/[\n\r]/);
    expect(reply).not.toContain("ghs_one");
    await served.close();
  });
});

describe("when there is no credential", () => {
  it("replies empty when the controller denies the request, so git tries the next helper", async () => {
    const served = await startCredentialSocket(() =>
      Promise.resolve(buildCredentialAnswer({ error: "unauthorized" })),
    );

    const reply = await askOverSocket(served.path, {
      protocol: "https",
      host: "github.com",
      path: "acme/web",
      sessionToken: "a-revoked-token",
    });

    expect(JSON.parse(reply.trim())).toEqual({});
    await served.close();
  });

  it("replies empty and asks nothing when the request has no token or workspace id", async () => {
    asked.length = 0;
    const served = await startCredentialSocket(() =>
      Promise.resolve(buildCredentialAnswer({ token: "the-token", username: "octocat" })),
    );

    const reply = await askOverSocket(served.path, {
      protocol: "https",
      host: "github.com",
      path: "acme/web",
    });

    expect(asked).toEqual([]);
    expect(JSON.parse(reply.trim())).toEqual({});
    await served.close();
  });

  it("replies empty when the controller cannot be reached", async () => {
    const served = await startCredentialSocket(() =>
      Promise.reject(new Error("the controller is disconnected")),
    );

    const reply = await askOverSocket(served.path, {
      protocol: "https",
      host: "github.com",
      path: "acme/web",
      sessionToken: "the-session-token",
    });

    // A disconnected controller must not hang git or crash the daemon.
    expect(JSON.parse(reply.trim())).toEqual({});
    await served.close();
  });
});

describe("an answer git would misread", () => {
  it("is not passed on when a field contains a line break", async () => {
    const served = await startCredentialSocket(() =>
      // git reads every line, so the extra line would be read as part of the answer.
      Promise.resolve(buildCredentialAnswer({ token: "the-token\nquit=1", username: "octocat" })),
    );

    const reply = await askOverSocket(served.path, {
      protocol: "https",
      host: "github.com",
      path: "acme/web",
      sessionToken: "the-session-token",
    });

    expect(JSON.parse(reply.trim())).toEqual({});
    await served.close();
  });
});

describe("a peer that sends no request line", () => {
  it("is disconnected instead of buffered, and the controller is not asked", async () => {
    asked.length = 0;
    const served = await startCredentialSocket(() =>
      Promise.resolve(buildCredentialAnswer({ token: "the-token", username: "octocat" })),
    );

    // How the peer notices the disconnect depends on the kernel. Where the
    // socket buffer is smaller than the write (macOS), the peer's write fails
    // with ECONNRESET. Where it is larger (Linux), the write completes and the
    // peer sees the close. The test waits for either. It also reads, because a
    // peer that never reads never sees the close.
    const cutOff = await new Promise<string>((resolve, reject) => {
      const socket = createConnection({ path: served.path });
      let received = "";
      socket.setEncoding("utf8");
      socket.on("connect", () => {
        // 100 KB with no newline: git never sends this, and the socket should
        // not keep it in memory.
        socket.write("x".repeat(100 * 1024));
      });
      socket.on("data", (chunk: string) => {
        received += chunk;
      });
      socket.on("close", () => resolve(received));
      socket.on("error", () => resolve(received));
      setTimeout(() => reject(new Error("the socket kept reading")), 5_000).unref();
    });

    // The peer is disconnected without a reply, because it sent no request.
    expect(cutOff).toBe("");
    expect(asked).toEqual([]);
    await served.close();
  }, 15_000);
});

describe("the socket itself", () => {
  it("can be opened only by this OS user", async () => {
    const served = await startCredentialSocket(() =>
      Promise.resolve(buildCredentialAnswer({ error: "no_connection" })),
    );

    // A process of the same user can already do anything the runner can, but
    // no other OS user can open the socket.
    expect(statSync(served.path).mode & 0o777).toBe(0o600);
    await served.close();
  });

  it("fails to start when another daemon is already listening on the socket", async () => {
    const served = await startCredentialSocket(() =>
      Promise.resolve(buildCredentialAnswer({ error: "no_connection" })),
    );

    // Two daemons on one Hercule Home could answer this machine's helpers with
    // credentials from two different controllers.
    await expect(
      serveCredentialSocket({
        path: served.path,
        ask: () => Promise.reject(new Error("never")),
        readGithubToken: () => Promise.reject(new Error("never")),
      }),
    ).rejects.toThrow("already listening");

    // The existing daemon's socket is left in place.
    expect(existsSync(served.path)).toBe(true);
    await served.close();
  });

  it("removes the socket file when it is closed", async () => {
    const served = await startCredentialSocket(() =>
      Promise.resolve(buildCredentialAnswer({ error: "no_connection" })),
    );

    await served.close();

    expect(existsSync(served.path)).toBe(false);
  });
});
