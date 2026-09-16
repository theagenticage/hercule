/**
 * `hydra git-credential get`, driven against a real socket. What git
 * reads on stdout is the whole contract: the exact two lines, or nothing at
 * all, which is git's signal to try the next helper.
 */
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { CredentialAnswer } from "@hydra/protocol";
import { helperMain, runCredentialAction, serveCredentialSocket } from "./index";
import { cleanTemporaries, temporary } from "../workspaces/testing";

afterAll(cleanTemporaries);

const answering = (fields: Omit<CredentialAnswer, "_tag" | "requestId">): CredentialAnswer => ({
  _tag: "credentialAnswer",
  requestId: crypto.randomUUID(),
  ...fields,
});

/** What git writes to a credential helper's stdin for a fetch over https. */
const GIT_ASKS = "protocol=https\nhost=github.com\npath=acme/web\n\n";

const asked: Array<unknown> = [];

const serving = async (
  answer: () => Promise<CredentialAnswer>,
): Promise<{ path: string; close: () => Promise<void> }> => {
  asked.length = 0;
  const path = join(temporary("hydra-helper-"), "daemon.sock");
  const server = await serveCredentialSocket({
    path,
    ask: (request) => {
      asked.push(request);
      return answer();
    },
  });
  return { path, close: () => server.close() };
};

describe("what the helper prints", () => {
  it("prints exactly the two lines git reads, from the answer the daemon gave", async () => {
    const served = await serving(() =>
      Promise.resolve(
        answering({
          token: "ghp_the-token",
          username: "octocat",
          name: "octocat",
          email: "octocat@users.noreply.github.com",
        }),
      ),
    );

    const printed = await helperMain(GIT_ASKS, {
      HYDRA_RUNNER_SOCKET: served.path,
      HYDRA_TOKEN: "the-session-token",
    });

    // Byte for byte: git parses this, and a trailing anything is a parse error.
    expect(printed).toBe("username=octocat\npassword=ghp_the-token\n");
    // The session proves itself with its own token; the remote is git's.
    expect(asked).toEqual([{ remote: "github.com/acme/web", sessionToken: "the-session-token" }]);
    await served.close();
  });

  it("prints nothing when the daemon answers empty", async () => {
    const served = await serving(() => Promise.resolve(answering({ error: "unauthorized" })));

    const printed = await helperMain(GIT_ASKS, {
      HYDRA_RUNNER_SOCKET: served.path,
      HYDRA_TOKEN: "a-foreign-token",
    });

    expect(printed).toBe("");
    await served.close();
  });

  it("prints nothing, and asks nothing, without a session token in its environment", async () => {
    const served = await serving(() =>
      Promise.resolve(answering({ token: "ghp_the-token", username: "octocat" })),
    );

    const printed = await helperMain(GIT_ASKS, { HYDRA_RUNNER_SOCKET: served.path });

    expect(printed).toBe("");
    expect(asked).toEqual([]);
    await served.close();
  });

  it("asks as the machine while the runner is provisioning a workspace", async () => {
    const served = await serving(() =>
      Promise.resolve(answering({ token: "ghp_the-token", username: "octocat" })),
    );

    const printed = await helperMain(GIT_ASKS, {
      HYDRA_RUNNER_SOCKET: served.path,
      HYDRA_WORKSPACE_PROVISIONING: "0199e0e7-0000-7000-8000-00000000000b",
    });

    // The machine has no session to be, so it names the workspace it is making.
    expect(asked).toEqual([
      { remote: "github.com/acme/web", workspaceId: "0199e0e7-0000-7000-8000-00000000000b" },
    ]);
    expect(printed).toBe("username=octocat\npassword=ghp_the-token\n");
    await served.close();
  });

  it("prints nothing when a field of the answer carries a line break", async () => {
    const served = await serving(() =>
      Promise.resolve(answering({ token: "ghp_the-token", username: "octocat\npassword=stolen" })),
    );

    const printed = await helperMain(GIT_ASKS, {
      HYDRA_RUNNER_SOCKET: served.path,
      HYDRA_TOKEN: "the-session-token",
    });

    // git reads the answer line by line: a break in a value is a line nobody
    // checked, and the last one wins.
    expect(printed).toBe("");
    await served.close();
  });

  it("prints nothing when there is no daemon to ask", async () => {
    const printed = await helperMain(GIT_ASKS, {
      HYDRA_RUNNER_SOCKET: join(temporary("hydra-helper-"), "nothing-listens-here.sock"),
      HYDRA_TOKEN: "the-session-token",
    });

    // git then falls through to the machine's own helpers, rather than failing.
    expect(printed).toBe("");
  });

  it("prints nothing when the environment names no socket at all", async () => {
    const printed = await helperMain(GIT_ASKS, { HYDRA_TOKEN: "the-session-token" });

    expect(printed).toBe("");
  });
});

describe("the actions git names", () => {
  it("says nothing, and reads no input, for anything but `get`", async () => {
    const written: Array<unknown> = [];
    const write = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      written.push(chunk);
      return true;
    });

    // `store` and `erase` are git reporting what it did with a credential this
    // helper keeps none of; a bare invocation is nobody's command at all.
    await runCredentialAction("store");
    await runCredentialAction("erase");
    await runCredentialAction("git-credential");
    await runCredentialAction(undefined);

    expect(written).toEqual([]);
    write.mockRestore();
  });
});
