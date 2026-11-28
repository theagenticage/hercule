/**
 * Tests `hercule git-credential get` against a real socket. What the helper
 * prints on stdout is all git sees: exactly two lines, or nothing at all, which
 * tells git to try the next helper.
 */
import { join } from "node:path";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from "vitest";
import type { CredentialAnswer } from "@hercule/protocol";
import {
  answerCredentialQuestion,
  RUNNER_WORKSPACE_VARIABLE,
  runCredentialAction,
  serveCredentialSocket,
} from "./index";
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
    // This file tests git's question only.
    readGithubToken: () => Promise.resolve({ reason: "not asked in this file" }),
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

  it("asks with the workspace id when the runner's own git works in a workspace", async () => {
    const served = await startCredentialSocket(() =>
      Promise.resolve(buildCredentialAnswer({ token: "ghp_the-token", username: "octocat" })),
    );

    const printed = await answerCredentialQuestion(GIT_ASKS, {
      HERCULE_RUNNER_SOCKET: served.path,
      [RUNNER_WORKSPACE_VARIABLE]: "0199e0e7-0000-7000-8000-00000000000b",
    });

    // No session exists while the runner provisions a workspace or runs a
    // workspace step, so the helper sends the workspace's id instead.
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
  const REFUSAL = `hercule: git-credential takes one action: get, store or erase. git runs it for you. Run "git help credential" for help.\n`;
  let stdout: MockInstance<typeof process.stdout.write>;
  let stderr: MockInstance<typeof process.stderr.write>;
  let stdin: MockInstance<typeof Bun.stdin.text>;

  beforeEach(() => {
    // Bun ignores `process.exitCode = undefined`, so the code is reset to 0.
    process.exitCode = 0;
    stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    // A regression that reads stdin must fail at once, not wait for input.
    stdin = vi.spyOn(Bun.stdin, "text").mockResolvedValue("");
  });

  afterEach(() => {
    process.exitCode = 0;
    vi.restoreAllMocks();
  });

  // git sends `store` and `erase` to report what it did with a credential, and
  // this helper stores none.
  it.each([["store"], ["erase"]])("prints nothing for `%s`", async (action) => {
    await runCredentialAction([action]);

    expect(stdin).not.toHaveBeenCalled();
    expect(stdout).not.toHaveBeenCalled();
    expect(stderr).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(0);
  });

  // Words after the action are ignored, as before: `get --help` answers a
  // well-formed request and gives no credential without one.
  it("still answers a request for `get --help`", async () => {
    await runCredentialAction(["get", "--help"]);

    expect(stdin).toHaveBeenCalledOnce();
    expect(stderr).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(0);
  });

  // gitcredentials(7) says a helper ignores any operation it does not know, so
  // that git can add one later. That is not an error.
  it.each([["foo"], ["git-credential"], ["future-operation"]])(
    "silently ignores the unknown action `%s`",
    async (action) => {
      await runCredentialAction([action]);

      expect(stdin).not.toHaveBeenCalled();
      expect(stdout).not.toHaveBeenCalled();
      expect(stderr).not.toHaveBeenCalled();
      expect(process.exitCode).toBe(0);
    },
  );

  // `--local` once reached the runner role as a daemon option and started a
  // local runner. git never passes a flag, or nothing, as the action.
  it.each([[[]], [["--local"]], [["--help"]], [["-x"]]])(
    "refuses %j with a message and exit code 2, and reads no stdin",
    async (args) => {
      await runCredentialAction(args);

      expect(stderr).toHaveBeenCalledWith(REFUSAL);
      expect(stdout).not.toHaveBeenCalled();
      expect(stdin).not.toHaveBeenCalled();
      expect(process.exitCode).toBe(2);
    },
  );
});
