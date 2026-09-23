/**
 * The local channel git's credential helper asks down: a Unix socket under the
 * runner's storage directory, readable by this OS user alone.
 *
 * This end resolves nothing. It turns git's question into the remote the
 * controller canonicalises, passes on the claim the asker made, and relays the
 * answer. Anything else - a claim nobody made, a refusal, a controller that
 * cannot be reached - is an empty answer, which is git's signal to try the next
 * helper rather than to fail.
 */
import { chmodSync, rmSync } from "node:fs";
import { createConnection, createServer, type Socket } from "node:net";
import type { CredentialAnswer } from "@hercule/protocol";

/** Long enough for a controller round trip, short enough that git is never hung on it. */
export const CREDENTIAL_DEADLINE_MS = 10_000;

/** The most one question may be. git's own are a few hundred bytes. */
const MAX_QUESTION_BYTES = 64 * 1024;

/** Who is asking, beside what they are asking for. Exactly one of the two. */
export type CredentialAsk = { readonly remote: string } & (
  { readonly sessionToken: string } | { readonly workspaceId: string }
);

/** One JSON line in, one JSON line out. */
interface HelperQuestion {
  readonly protocol?: string;
  readonly host?: string;
  readonly path?: string;
  readonly sessionToken?: string;
  readonly workspaceId?: string;
}

const EMPTY = "{}\n";

/**
 * A credential git can be handed. Git reads a helper's answer as lines, so a
 * value carrying a newline would let whoever chose it add a line of its own -
 * another host's credential, or a `quit=1` that stops git asking anyone else.
 */
export const isSpeakable = (value: string): boolean => !/[\n\r\0]/.test(value);

/** `<host>/<path>`, the way spec 13 section 9 names the thing git is talking to. */
const formatRemote = (question: HelperQuestion): string =>
  [question.host, question.path].filter((part) => part !== undefined && part.length > 0).join("/");

const buildCredentialAsk = (question: HelperQuestion): CredentialAsk | undefined => {
  const remote = formatRemote(question);
  if (remote.length === 0) return undefined;
  // A session's own token is the stronger claim, and the runner never makes one
  // on a session's behalf.
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
    // A refusal is an answer with no credential in it, which is an empty reply
    // to git: it falls through to whatever helper comes next.
    if (!("token" in answer)) return EMPTY;
    const { token, username } = answer;
    if (!isSpeakable(token) || !isSpeakable(username)) return EMPTY;
    return `${JSON.stringify({ username, password: token })}\n`;
  } catch {
    // A controller that is not there is not an error git can act on.
    return EMPTY;
  }
};

/** Whether a daemon is already listening there, which is not a path to unlink. */
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
        // One question is one line; a peer that sends no newline is not asking,
        // and is not read any further either.
        if (received.length > MAX_QUESTION_BYTES) {
          // Nothing is written back. An unread reply sits in the peer's receive
          // buffer ahead of the close, and a peer that is not reading - which
          // this one, mid-write, is not - would never reach the close behind it
          // on a kernel whose socket buffer swallowed its whole write. The
          // cut-off is the only thing it is told.
          connection.removeAllListeners("data");
          connection.destroy();
        }
        return;
      }
      const line = received.slice(0, newline);
      // One question per connection: what follows the first line is nobody's.
      connection.removeAllListeners("data");
      void answerQuestionLine(line, options.ask).then((reply) => connection.end(reply));
    });
    // A helper that went away mid-question leaves nothing to clean up.
    connection.on("error", () => connection.destroy());
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    // A socket file left by a daemon that was killed would refuse the bind, and
    // nothing answers at it: that has just been checked.
    rmSync(options.path, { force: true });
    server.listen(options.path, () => {
      // The directory already keeps other users out; this keeps them out of the
      // socket itself, wherever the directory's mode came from.
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
