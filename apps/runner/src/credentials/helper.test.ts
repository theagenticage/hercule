/**
 * Tests `hercule git-credential get` against a real socket. What the helper
 * prints on stdout is all git sees: exactly two lines, or nothing at all, which
 * tells git to try the next helper.
 */
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { CredentialAnswer } from "@hercule/protocol";
import { answerCredentialQuestion, runCredentialAction, serveCredentialSocket } from "./index";
import { cleanTemporaries, createTemporaryDir } from "../workspaces/testing";

afterAll(cleanTemporaries);

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

/** What git writes to a credential helper's stdin for a fetch over https. */
const GIT_ASKS = "protocol=https\nhost=github.com\npath=acme/web\n\n";

const asked: Array<unknown> = [];

const startCredentialSocket = async (
  answer: () => Promise<CredentialAnswer>,
): Promise<{ path: string; close: () => Promise<void> }> => {
  asked.length = 0;
  const path = join(createTemporaryDir("hercule-helper-"), "daemon.sock");
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
  it("prints exactly the two lines git reads, built from the daemon's answer", async () => {
    const served = await startCredentialSocket(() =>
      Promise.resolve(
        // The answer holds only the credential. The session's git identity is
        // sent separately, on `sessionStart`.
        buildCredentialAnswer({ token: "ghp_the-token", username: "octocat" }),
      ),
    );

    const printed = await answerCredentialQuestion(GIT_ASKS, {
      HERCULE_RUNNER_SOCKET: served.path,
      HERCULE_TOKEN: "the-session-token",
    });

    // Compare byte for byte: git parses this, and any extra trailing text is a parse error.
    expect(printed).toBe("username=octocat\npassword=ghp_the-token\n");
    // The session identifies itself with its own token; the remote comes from git's request.
    expect(asked).toEqual([{ remote: "github.com/acme/web", sessionToken: "the-session-token" }]);
    await served.close();
  });

  it("prints nothing when the daemon returns no credential", async () => {
    const served = await startCredentialSocket(() =>
      Promise.resolve(buildCredentialAnswer({ error: "unauthorized" })),
    );

    const printed = await answerCredentialQuestion(GIT_ASKS, {
      HERCULE_RUNNER_SOCKET: served.path,
      HERCULE_TOKEN: "a-foreign-token",
    });

    expect(printed).toBe("");
    await served.close();
  });

  it("prints nothing and asks nothing when its environment has no session token", async () => {
    const served = await startCredentialSocket(() =>
      Promise.resolve(buildCredentialAnswer({ token: "ghp_the-token", username: "octocat" })),
    );

    const printed = await answerCredentialQuestion(GIT_ASKS, {
      HERCULE_RUNNER_SOCKET: served.path,
    });

    expect(printed).toBe("");
    expect(asked).toEqual([]);
    await served.close();
  });

  it("asks with the workspace id while the runner is provisioning a workspace", async () => {
    const served = await startCredentialSocket(() =>
      Promise.resolve(buildCredentialAnswer({ token: "ghp_the-token", username: "octocat" })),
    );

    const printed = await answerCredentialQuestion(GIT_ASKS, {
      HERCULE_RUNNER_SOCKET: served.path,
      HERCULE_WORKSPACE_PROVISIONING: "0199e0e7-0000-7000-8000-00000000000b",
    });

    // There is no session yet, so the helper sends the id of the workspace being provisioned.
    expect(asked).toEqual([
      { remote: "github.com/acme/web", workspaceId: "0199e0e7-0000-7000-8000-00000000000b" },
    ]);
    expect(printed).toBe("username=octocat\npassword=ghp_the-token\n");
    await served.close();
  });

  it("prints nothing when a field of the answer contains a line break", async () => {
    const served = await startCredentialSocket(() =>
      Promise.resolve(
        buildCredentialAnswer({ token: "ghp_the-token", username: "octocat\npassword=stolen" }),
      ),
    );

    const printed = await answerCredentialQuestion(GIT_ASKS, {
      HERCULE_RUNNER_SOCKET: served.path,
      HERCULE_TOKEN: "the-session-token",
    });

    // git reads the answer line by line, so a line break in a value would add
    // an unchecked line, and git uses the last value it reads for a key.
    expect(printed).toBe("");
    await served.close();
  });

  it("prints nothing when there is no daemon to ask", async () => {
    const printed = await answerCredentialQuestion(GIT_ASKS, {
      HERCULE_RUNNER_SOCKET: join(
        createTemporaryDir("hercule-helper-"),
        "nothing-listens-here.sock",
      ),
      HERCULE_TOKEN: "the-session-token",
    });

    // git then moves on to the machine's own helpers instead of failing.
    expect(printed).toBe("");
  });

  it("prints nothing when the environment has no socket path", async () => {
    const printed = await answerCredentialQuestion(GIT_ASKS, {
      HERCULE_TOKEN: "the-session-token",
    });

    expect(printed).toBe("");
  });
});

describe("the actions git passes", () => {
  it("prints nothing for any action other than `get`", async () => {
    const written: Array<unknown> = [];
    const write = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      written.push(chunk);
      return true;
    });

    // git sends `store` and `erase` to report what it did with a credential,
    // and this helper stores none. A missing action is not a git command at all.
    await runCredentialAction("store");
    await runCredentialAction("erase");
    await runCredentialAction("git-credential");
    await runCredentialAction(undefined);

    expect(written).toEqual([]);
    write.mockRestore();
  });
});
