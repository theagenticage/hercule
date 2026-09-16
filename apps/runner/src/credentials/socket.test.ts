/**
 * The runner's credential channel (AC-13, AD-2): a Unix socket that resolves
 * nothing itself. It turns git's question into a request for the controller and
 * relays the answer back; anything else is an empty answer, which is what lets
 * git fall through to the machine's own helpers.
 */
import { existsSync, statSync } from "node:fs";
import { createConnection } from "node:net";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { CredentialAnswer } from "@hydra/protocol";
import { serveCredentialSocket } from "./index";
import { cleanTemporaries, temporary } from "../workspaces/testing";

afterAll(cleanTemporaries);

const socketPath = (): string => join(temporary("hydra-credentials-"), "daemon.sock");

const answering = (fields: Omit<CredentialAnswer, "_tag" | "requestId">): CredentialAnswer => ({
  _tag: "credentialAnswer",
  requestId: crypto.randomUUID(),
  ...fields,
});

/** One question down the socket, one line back, the way the helper asks it. */
const asks = (path: string, request: Record<string, string>): Promise<string> =>
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

const serving = async (
  answer: (request: unknown) => Promise<CredentialAnswer>,
): Promise<{ path: string; close: () => Promise<void> }> => {
  const path = socketPath();
  const server = await serveCredentialSocket({
    path,
    ask: (request) => {
      asked.push(request);
      return answer(request);
    },
  });
  return { path, close: () => server.close() };
};

describe("what the socket relays", () => {
  it("asks the controller for the remote git named, on behalf of the session that asked", async () => {
    asked.length = 0;
    const served = await serving(() =>
      Promise.resolve(answering({ token: "the-token", username: "octocat" })),
    );

    const reply = await asks(served.path, {
      protocol: "https",
      host: "github.com",
      path: "acme/web",
      sessionToken: "the-session-token",
    });

    // The remote is what the controller canonicalises; the token is the claim.
    expect(asked).toEqual([{ remote: "github.com/acme/web", sessionToken: "the-session-token" }]);
    expect(JSON.parse(reply.trim())).toEqual({ username: "octocat", password: "the-token" });
    await served.close();
  });

  it("carries a workspace id instead, for the runner's own git while it provisions", async () => {
    asked.length = 0;
    const served = await serving(() =>
      Promise.resolve(answering({ token: "the-token", username: "octocat" })),
    );

    await asks(served.path, {
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

describe("when no credential is coming", () => {
  it("answers empty on a refusal, so git falls through to the machine's helpers", async () => {
    const served = await serving(() => Promise.resolve(answering({ error: "unauthorized" })));

    const reply = await asks(served.path, {
      protocol: "https",
      host: "github.com",
      path: "acme/web",
      sessionToken: "a-revoked-token",
    });

    expect(JSON.parse(reply.trim())).toEqual({});
    await served.close();
  });

  it("answers empty, and asks nobody, when the request proves nothing", async () => {
    asked.length = 0;
    const served = await serving(() =>
      Promise.resolve(answering({ token: "the-token", username: "octocat" })),
    );

    const reply = await asks(served.path, {
      protocol: "https",
      host: "github.com",
      path: "acme/web",
    });

    expect(asked).toEqual([]);
    expect(JSON.parse(reply.trim())).toEqual({});
    await served.close();
  });

  it("answers empty when the controller cannot be reached", async () => {
    const served = await serving(() => Promise.reject(new Error("the controller is disconnected")));

    const reply = await asks(served.path, {
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

describe("the socket itself", () => {
  it("is reachable by this user alone", async () => {
    const served = await serving(() => Promise.resolve(answering({ error: "no_connection" })));

    // AD-2: a same-user process is at parity with the runner anyway, but no
    // other OS user reaches this.
    expect(statSync(served.path).mode & 0o777).toBe(0o600);
    await served.close();
  });

  it("is gone once it is closed", async () => {
    const served = await serving(() => Promise.resolve(answering({ error: "no_connection" })));

    await served.close();

    expect(existsSync(served.path)).toBe(false);
  });
});
