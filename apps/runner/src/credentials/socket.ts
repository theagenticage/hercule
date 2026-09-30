/**
 * The Unix socket that git's credential helper connects to. It lives in the
 * runner's storage directory and only this OS user can open it.
 *
 * The socket does not look up credentials itself. It builds the remote from
 * git's request, passes on the helper's session token or workspace id, and
 * returns the controller's answer. In every other case it returns an empty
 * reply, which tells git to try the next helper instead of failing. That
 * includes a request with no token or workspace id, a denied credential, and a
 * controller that cannot be reached.
 */
import { chmodSync, rmSync } from "node:fs";
import { createConnection, createServer, type Socket } from "node:net";
import type { CredentialAnswer } from "@hercule/protocol";

/** Long enough for a round trip to the controller, short enough that git never hangs on it. */
export const CREDENTIAL_DEADLINE_MS = 10_000;

/** The largest request the socket reads. git's requests are a few hundred bytes. */
const MAX_QUESTION_BYTES = 64 * 1024;

/** A credential request: the remote, plus exactly one of a session token or a workspace id. */
export type CredentialAsk = { readonly remote: string } & (
  { readonly sessionToken: string } | { readonly workspaceId: string }
);

/** The helper's request: one JSON line. The reply is also one JSON line. */
interface HelperQuestion {
  readonly protocol?: string;
  readonly host?: string;
  readonly path?: string;
  readonly sessionToken?: string;
  readonly workspaceId?: string;
}

const EMPTY = "{}\n";

/**
 * Checks that a credential value is safe to give to git. git reads a helper's
 * answer as lines, so a value with a newline could add a line of its own, such
 * as another host's credential or a `quit=1` that stops git asking any other
 * helper.
 */
export const isSpeakable = (value: string): boolean => !/[\n\r\0]/.test(value);

/**
 * Returns the remote as `<host>/<path>`, the form a credential request carries.
 * The controller converts it to the canonical form of the remote.
 */
const formatRemote = (question: HelperQuestion): string =>
  [question.host, question.path].filter((part) => part !== undefined && part.length > 0).join("/");

const buildCredentialAsk = (question: HelperQuestion): CredentialAsk | undefined => {
  const remote = formatRemote(question);
  if (remote.length === 0) return undefined;
  // A session token takes precedence over a workspace id: the token proves
  // which session is asking, and the runner never sends one itself.
  if (question.sessionToken !== undefined) {
    return { remote, sessionToken: question.sessionToken };
  }
  return question.workspaceId === undefined
    ? undefined
    : { remote, workspaceId: question.workspaceId };
};

const answerQuestionLine = async (
  line: string,
  ask: (request: CredentialAsk) => Promise<CredentialAnswer>,
): Promise<string> => {
  let question: HelperQuestion;
  try {
    question = JSON.parse(line) as HelperQuestion;
  } catch {
    return EMPTY;
  }
  const asking = buildCredentialAsk(question);
  if (asking === undefined) return EMPTY;
  try {
    const answer = await ask(asking);
    // A denial is an answer with no credential in it. It becomes an empty reply,
    // and git moves on to the next helper.
    if (!("token" in answer)) return EMPTY;
    const { token, username } = answer;
    if (!isSpeakable(token) || !isSpeakable(username)) return EMPTY;
    return `${JSON.stringify({ username, password: token })}\n`;
  } catch {
    // git cannot do anything about an unreachable controller, so reply empty.
    return EMPTY;
  }
};

/**
 * Checks whether a daemon is already listening at `path`, in which case the socket file must not be
 * removed.
 */
const isDaemonListening = (path: string): Promise<boolean> =>
  new Promise((resolve) => {
    const probe = createConnection({ path });
    probe.on("connect", () => {
      probe.destroy();
      resolve(true);
    });
    probe.on("error", () => {
      probe.destroy();
      resolve(false);
    });
  });

export const serveCredentialSocket = async (options: {
  readonly path: string;
  readonly ask: (request: CredentialAsk) => Promise<CredentialAnswer>;
}): Promise<{ close(): Promise<void> }> => {
  if (await isDaemonListening(options.path)) {
    throw new Error(
      `another Hercule runner is already listening at ${options.path}; ` +
        "only one daemon may run against one Hercule home",
    );
  }
  const server = createServer((connection: Socket) => {
    let received = "";
    connection.setEncoding("utf8");
    connection.on("data", (chunk: string) => {
      received += chunk;
      const newline = received.indexOf("\n");
      if (newline < 0) {
        // A request is one line. Keep reading until the newline arrives, but
        // stop once the peer has sent more than a request can be.
        if (received.length > MAX_QUESTION_BYTES) {
          // Close without a reply. A peer that is still writing is not reading,
          // so a reply would sit unread in its receive buffer ahead of the
          // close. If the kernel buffered the peer's whole write, the peer would
          // then never see the close. Closing alone is the one signal it is
          // sure to get.
          connection.removeAllListeners("data");
          connection.destroy();
        }
        return;
      }
      const line = received.slice(0, newline);
      // One request per connection: anything after the first line is ignored.
      connection.removeAllListeners("data");
      void answerQuestionLine(line, options.ask).then((reply) => connection.end(reply));
    });
    // A helper that disconnects mid-request leaves nothing to clean up.
    connection.on("error", () => connection.destroy());
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    // A socket file left behind by a killed daemon would make the bind fail.
    // No daemon is listening at it (checked above), so it is safe to remove.
    rmSync(options.path, { force: true });
    server.listen(options.path, () => {
      // The directory already keeps other users out. This also keeps them out of
      // the socket itself, whatever the directory's mode is.
      chmodSync(options.path, 0o600);
      resolve({
        close: () =>
          new Promise((closed) => {
            server.close(() => {
              rmSync(options.path, { force: true });
              closed();
            });
          }),
      });
    });
  });
};
