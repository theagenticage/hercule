/**
 * `hercule github-token`: the client the `gh` shim runs on every `gh` call.
 *
 * It asks the runner daemon for the session's GitHub token over the daemon's
 * credential socket and prints the token. The shim puts it in `GH_TOKEN` for
 * that one `gh` call, so a token never stays in a session's environment long
 * enough to expire.
 *
 * This runs on every `gh` call, so startup time counts. The compiled binary
 * starts this file without the dispatcher, the runner or `effect`, so keep its
 * imports to Node built-ins and the two small modules below. `pnpm dep-lint`
 * checks this. A type-only import is erased and costs nothing.
 *
 * The default deadline is `CREDENTIAL_DEADLINE_MS`, longer than the time the
 * runner waits for the controller, so the runner can answer from its own copy
 * of the token before this client gives up on it.
 */
import { createConnection } from "node:net";
import type { GithubTokenResult } from "./github-tokens";
import { RUNNER_SOCKET_VARIABLE, SESSION_TOKEN_VARIABLE } from "./helper";
import { CREDENTIAL_DEADLINE_MS } from "./socket";

/**
 * Sends one request line to the runner daemon and returns its reply. Returns a
 * `reason` of this client's own when the daemon cannot be reached, closes the
 * connection without a reply, or does not answer within `deadlineMs`.
 */
const askRunner = (
  path: string,
  sessionToken: string,
  deadlineMs: number,
): Promise<GithubTokenResult> =>
  new Promise((resolve) => {
    const socket = createConnection({ path });
    let received = "";
    const finish = (outcome: GithubTokenResult): void => {
      socket.destroy();
      resolve(outcome);
    };
    socket.setEncoding("utf8");
    socket.setTimeout(deadlineMs, () => finish({ reason: "the runner did not answer in time" }));
    socket.on("connect", () =>
      socket.write(`${JSON.stringify({ kind: "githubToken", sessionToken })}\n`),
    );
    socket.on("data", (chunk: string) => {
      received += chunk;
      if (received.includes("\n")) finish(parseReply(received));
    });
    socket.on("end", () =>
      finish({ reason: "the runner closed the connection without answering" }),
    );
    socket.on("error", () => finish({ reason: "the runner could not be reached" }));
  });

/** Parses the daemon's reply line, which is `{"token":...}` or `{"reason":...}`. */
const parseReply = (line: string): GithubTokenResult => {
  try {
    const reply = JSON.parse(line) as { token?: unknown; reason?: unknown };
    if (typeof reply.token === "string" && reply.token.length > 0) return { token: reply.token };
    if (typeof reply.reason === "string" && reply.reason.length > 0)
      return { reason: reply.reason };
  } catch {
    // Falls through to the same reason as a reply with neither field.
  }
  return { reason: "the runner sent an answer that could not be read" };
};

/**
 * Prints the session's GitHub token on stdout, or one line on stderr saying why
 * there is none, and sets the exit code to 0 or 1.
 *
 * `env` is where the runner's socket path and the session token are read from.
 * Without both, this is not a session the runner started, so it does not
 * connect at all.
 */
export const runGithubToken = async (
  env: Record<string, string | undefined> = process.env,
  deadlineMs: number = CREDENTIAL_DEADLINE_MS,
): Promise<void> => {
  const path = env[RUNNER_SOCKET_VARIABLE];
  const sessionToken = env[SESSION_TOKEN_VARIABLE];
  const outcome: GithubTokenResult =
    path === undefined ||
    path.length === 0 ||
    sessionToken === undefined ||
    sessionToken.length === 0
      ? { reason: "not in a Hercule session" }
      : await askRunner(path, sessionToken, deadlineMs);
  if ("token" in outcome) {
    process.stdout.write(`${outcome.token}\n`);
    return;
  }
  process.stderr.write(`hercule: no fresh GitHub token (${outcome.reason})\n`);
  process.exitCode = 1;
};
