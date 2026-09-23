/**
 * `hercule git-credential <action>`: the credential helper git runs each time
 * it needs a credential.
 *
 * The helper stores nothing. It asks the runner daemon over this machine's
 * socket and prints the credential it gets back. To identify itself it sends
 * what its environment holds: the session's own token, or the id of the
 * workspace the runner is provisioning. In every other case it prints nothing,
 * so git moves on to the machine's own helpers instead of failing.
 */
import { createConnection } from "node:net";
import { CREDENTIAL_DEADLINE_MS, isSpeakable } from "./socket";

/** The session's own token, injected by the runner into the session's environment. */
const TOKEN = "HERCULE_TOKEN";

/**
 * The workspace the runner is provisioning, set for the runner's own git commands during
 * provisioning.
 */
const PROVISIONING = "HERCULE_WORKSPACE_PROVISIONING";

const SOCKET = "HERCULE_RUNNER_SOCKET";

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
  const path = env[SOCKET];
  if (path === undefined || path.length === 0) return "";
  const token = env[TOKEN];
  const provisioning = env[PROVISIONING];
  const claim =
    token !== undefined && token.length > 0
      ? { sessionToken: token }
      : provisioning !== undefined && provisioning.length > 0
        ? { workspaceId: provisioning }
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
 * - `get` prints the credential, or nothing when there is none.
 * - `store` and `erase` do nothing, because this helper stores no credentials.
 * - Any other action also does nothing and succeeds, because git shows the
 *   user an error for a helper that fails.
 */
export const runCredentialAction = async (action: string | undefined): Promise<void> => {
  if (action !== "get") return;
  process.stdout.write(await answerCredentialQuestion(await Bun.stdin.text(), process.env));
};
