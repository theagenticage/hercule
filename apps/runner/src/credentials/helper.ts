/**
 * `hercule git-credential <action>`: the credential helper git runs each time
 * it needs a credential.
 *
 * The helper stores nothing. It asks the runner daemon over this machine's
 * socket and prints the credential it gets back. To identify itself it sends
 * what its environment holds: the session's own token, or the id of the
 * workspace the runner is provisioning or running a workspace step in. In
 * every other case it prints nothing, so git moves on to the machine's own
 * helpers instead of failing.
 */
import { createConnection } from "node:net";
import { CREDENTIAL_DEADLINE_MS, isSpeakable } from "./socket";

/** The environment variable that holds the session's own token, injected by the runner. */
export const SESSION_TOKEN_VARIABLE = "HERCULE_TOKEN";

/**
 * The environment variable that holds the id of the workspace the runner's
 * own git works in. The runner sets it for its git commands while it
 * provisions a workspace and while it runs a workspace step, because no
 * session, and so no session token, exists then.
 */
export const RUNNER_WORKSPACE_VARIABLE = "HERCULE_RUNNER_WORKSPACE";

/** The environment variable that holds the path of the runner daemon's credential socket. */
export const RUNNER_SOCKET_VARIABLE = "HERCULE_RUNNER_SOCKET";

/** Parses git's credential request, which is `key=value` lines ending with a blank line. */
const parseHelperQuestion = (input: string): Record<string, string> => {
  const fields: Record<string, string> = {};
  for (const line of input.split("\n")) {
    const at = line.indexOf("=");
    if (at > 0) fields[line.slice(0, at)] = line.slice(at + 1);
  }
  return fields;
};

const askDaemon = (path: string, question: unknown): Promise<string> =>
  new Promise((resolve) => {
    const socket = createConnection({ path });
    let received = "";
    const finishWithAnswer = (answer: string): void => {
      socket.destroy();
      resolve(answer);
    };
    socket.setEncoding("utf8");
    socket.setTimeout(CREDENTIAL_DEADLINE_MS, () => finishWithAnswer(""));
    socket.on("connect", () => socket.write(`${JSON.stringify(question)}\n`));
    socket.on("data", (chunk: string) => {
      received += chunk;
      if (received.includes("\n")) finishWithAnswer(received);
    });
    socket.on("end", () => finishWithAnswer(received));
    // A missing daemon, a missing socket or a permission error all mean "no credential".
    socket.on("error", () => finishWithAnswer(""));
  });

export const answerCredentialQuestion = async (
  input: string,
  env: Record<string, string | undefined>,
): Promise<string> => {
  const path = env[RUNNER_SOCKET_VARIABLE];
  if (path === undefined || path.length === 0) return "";
  const token = env[SESSION_TOKEN_VARIABLE];
  const workspaceId = env[RUNNER_WORKSPACE_VARIABLE];
  const claim =
    token !== undefined && token.length > 0
      ? { sessionToken: token }
      : workspaceId !== undefined && workspaceId.length > 0
        ? { workspaceId }
        : undefined;
  // Without a token or a workspace id the daemon would reject the request
  // anyway, so skip the round trip while git waits.
  if (claim === undefined) return "";
  const question = parseHelperQuestion(input);
  const answer = await askDaemon(path, {
    protocol: question["protocol"],
    host: question["host"],
    path: question["path"],
    ...claim,
  });
  try {
    const { username, password } = JSON.parse(answer) as {
      username?: string;
      password?: string;
    };
    if (username === undefined || password === undefined) return "";
    // git would read a value with a line break in it as two lines, and the
    // second line would be unchecked input.
    if (!isSpeakable(username) || !isSpeakable(password)) return "";
    return `username=${username}\npassword=${password}\n`;
  } catch {
    return "";
  }
};

/**
 * Runs `hercule git-credential <action>`. git passes the request on stdin.
 *
 * `args` are the words after `git-credential`, global options excluded. Only
 * the first word is read, so `get --help` still answers a well-formed request.
 *
 * - `get` prints the credential, or nothing when there is none.
 * - `store` and `erase` do nothing, because this helper stores no credentials.
 * - Any other action word also does nothing and exits 0, reading no stdin.
 * - No word, or a word that starts with `-`, prints a refusal on stderr, reads
 *   nothing from stdin, and sets the exit code to 2. git never passes a flag as
 *   the action, so this only happens when a person or a script runs the
 *   command by hand. The refusal also keeps the flag from being read as an
 *   option of the runner daemon, such as `--local`.
 */
export const runCredentialAction = async (args: readonly string[]): Promise<void> => {
  const action = args[0];
  if (action === undefined || action.startsWith("-")) {
    process.stderr.write(
      `hercule: git-credential takes one action: get, store or erase. git runs it for you. Run "git help credential" for help.\n`,
    );
    process.exitCode = 2;
    return;
  }
  // gitcredentials(7): "If a helper receives any other operation, it should
  // silently ignore the request. This leaves us room for future operations to
  // be introduced." An error here would show on every git call once git adds one.
  if (action !== "get") return;
  process.stdout.write(await answerCredentialQuestion(await Bun.stdin.text(), process.env));
};
