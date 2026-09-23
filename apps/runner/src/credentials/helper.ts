/**
 * `hercule git-credential <action>`: the helper git runs, once per request it
 * needs a credential for.
 *
 * It knows nothing and stores nothing. It asks the daemon on this machine's
 * socket, proving who it is with what its environment carries - a session's own
 * token, or the workspace the runner is provisioning - and prints what comes
 * back. Anything else prints nothing, which is how git falls through to the
 * machine's own helpers instead of failing.
 */
import { createConnection } from "node:net";
import { CREDENTIAL_DEADLINE_MS, isSpeakable } from "./socket";

/** The session's own token, injected by the runner into the session's environment. */
const TOKEN = "HERCULE_TOKEN";

/** The workspace the runner is making, for the runner's own git while it makes it. */
const PROVISIONING = "HERCULE_WORKSPACE_PROVISIONING";

const SOCKET = "HERCULE_RUNNER_SOCKET";

/** git writes `key=value` lines and ends with a blank one. */
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
    // No daemon, no socket, no permission: all of them are "no credential".
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
  // Nothing to prove is nothing to ask: the daemon would refuse it anyway, and
  // git is waiting on this.
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
    // A value with a line break in it would be two answers to git, the second
    // one nobody checked.
    if (!isSpeakable(username) || !isSpeakable(password)) return "";
    return `username=${username}\npassword=${password}\n`;
  } catch {
    return "";
  }
};

/**
 * What the runner role does with `hercule git-credential <action>`. git calls it
 * with the request on stdin and names an action; only `get` has an answer, and
 * `store` and `erase` are git reporting what it did with a credential this
 * helper keeps none of. Anything else is a word nobody meant: it says nothing
 * and succeeds, because a helper that fails is one git reports at the user.
 */
export const runCredentialAction = async (action: string | undefined): Promise<void> => {
  if (action !== "get") return;
  process.stdout.write(await answerCredentialQuestion(await Bun.stdin.text(), process.env));
};
