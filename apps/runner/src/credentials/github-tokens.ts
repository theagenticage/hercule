/**
 * The runner's in-memory copy of each GitHub Connection's token, and the rule
 * for when a session may be handed it.
 *
 * A session holds no token of its own. The `gh` shim asks the runner each time
 * it runs, and the runner answers from a copy per Connection. The copy exists
 * so that `gh` stays fast, but it must not outlive the Connection:
 *
 * - A copy is served without asking only while it is fresh: younger than
 *   5 minutes, and with no expiry or an expiry more than 10 minutes away. The
 *   5 minutes bound how long a deleted or disconnected Connection can keep
 *   reaching its sessions. GitHub tokens expire after about 8 hours. The
 *   controller refreshes a token on demand when it is within 10 minutes of
 *   expiring, so a runner that asks inside that margin gets a new token before
 *   the old one stops working.
 * - A copy that is not fresh is asked for again. A copy that has not expired
 *   yet is still served when the controller cannot be reached.
 * - A refusal from the controller drops the copy, so the Connection stops
 *   reaching its sessions at once.
 *
 * The token lives in memory only. It is never written to disk or to a log.
 */
import type { GithubTokenAnswer } from "@hercule/protocol";

const COPY_MAX_AGE_MS = 5 * 60 * 1000;
const EXPIRY_MARGIN_MS = 10 * 60 * 1000;

const NOT_BOUND_REASON = "this runner holds no GitHub token for this session";
const UNREACHABLE_REASON =
  "the controller could not be reached, and this runner's copy of the token has expired";

/** What a session is handed: the token, or a one-line human-readable reason there is none. */
export type GithubTokenResult = { readonly token: string } | { readonly reason: string };

/** The runner's per-Connection copies of GitHub tokens, and the sessions bound to them. */
export interface GithubTokenCopies {
  /**
   * Binds a session to its Connection and seeds the Connection's copy with the
   * session's start token. The start token replaces an existing copy only when
   * it expires later than the copy. A session can take a long time to
   * prepare before it is held, so its start token may be older than a copy
   * that another session refreshed in the meantime. A start token with no
   * expiry (a pasted token) never replaces a copy; the copy is asked for again
   * within 5 minutes anyway. A copy
   * that is kept keeps its `fetchedAt`. Returns a function that releases the
   * session. It is safe to call more than once. Releasing
   * the last session of a Connection drops the Connection's copy.
   */
  readonly hold: (session: {
    readonly sessionToken: string;
    readonly connectionId: string;
    readonly githubToken: string;
    readonly expiresAt?: string;
  }) => () => void;
  /**
   * Returns the token for a session, asking the controller when the copy is
   * not fresh. Never rejects: every failure comes back as a `reason`.
   */
  readonly read: (sessionToken: string) => Promise<GithubTokenResult>;
}

interface Copy {
  readonly token: string;
  readonly fetchedAt: number;
  readonly expiresAt: number | undefined;
}

/** The state of one Connection. Replaced, never reused, once its last session is released. */
interface ConnectionEntry {
  readonly sessions: Set<string>;
  copy: Copy | undefined;
  asking: Promise<GithubTokenResult> | undefined;
}

/**
 * Creates the store of GitHub token copies and returns its `hold` and `read`
 * functions. Create one per daemon: it must outlive the connections to the
 * controller, because a session keeps its token through a reconnect.
 */
export const makeGithubTokenCopies = (dependencies: {
  /** Asks the controller for a session's token. Rejects when the controller gives no answer. */
  readonly ask: (sessionToken: string) => Promise<GithubTokenAnswer>;
  readonly now?: () => number;
}): GithubTokenCopies => {
  const now = dependencies.now ?? Date.now;
  const connections = new Map<string, ConnectionEntry>();
  const connectionOfSession = new Map<string, string>();

  const isFresh = (copy: Copy): boolean =>
    now() - copy.fetchedAt < COPY_MAX_AGE_MS &&
    (copy.expiresAt === undefined || copy.expiresAt - now() > EXPIRY_MARGIN_MS);

  const hasExpired = (copy: Copy): boolean =>
    copy.expiresAt !== undefined && copy.expiresAt <= now();

  const buildCopy = (token: string, expiresAt: string | undefined): Copy => ({
    token,
    fetchedAt: now(),
    expiresAt: expiresAt === undefined ? undefined : Date.parse(expiresAt),
  });

  /**
   * Asks the controller and applies the answer. An answer that arrives after
   * the Connection's last session was released is served to the caller but not
   * stored: storing it would recreate a copy nothing is left to release. An
   * answer is not stored either when a session start replaced the copy while
   * the ask was in flight: that start token was read later than the question.
   */
  const refresh = async (
    connectionId: string,
    entry: ConnectionEntry,
    sessionToken: string,
  ): Promise<GithubTokenResult> => {
    const copyWhenAsked = entry.copy;
    let answer: GithubTokenAnswer;
    try {
      answer = await dependencies.ask(sessionToken);
    } catch {
      // Without an answer, an unexpired copy is still the best token there is.
      const copy = entry.copy;
      return copy !== undefined && !hasExpired(copy)
        ? { token: copy.token }
        : { reason: UNREACHABLE_REASON };
    }
    const isCurrent = connections.get(connectionId) === entry;
    if ("reason" in answer) {
      if (isCurrent) entry.copy = undefined;
      return { reason: answer.reason };
    }
    if (isCurrent && entry.copy === copyWhenAsked) {
      entry.copy = buildCopy(answer.token, answer.expiresAt);
    }
    return { token: answer.token };
  };

  return {
    hold: ({ sessionToken, connectionId, githubToken, expiresAt }) => {
      let entry = connections.get(connectionId);
      if (entry === undefined) {
        entry = { sessions: new Set(), copy: undefined, asking: undefined };
        connections.set(connectionId, entry);
      }
      const held = entry;
      held.sessions.add(sessionToken);
      connectionOfSession.set(sessionToken, connectionId);
      const started = buildCopy(githubToken, expiresAt);
      const copy = held.copy;
      if (
        copy === undefined ||
        (started.expiresAt !== undefined &&
          (copy.expiresAt === undefined || started.expiresAt > copy.expiresAt))
      ) {
        held.copy = started;
      }

      return () => {
        if (!held.sessions.delete(sessionToken)) return;
        connectionOfSession.delete(sessionToken);
        if (held.sessions.size === 0 && connections.get(connectionId) === held) {
          connections.delete(connectionId);
        }
      };
    },

    read: async (sessionToken) => {
      const connectionId = connectionOfSession.get(sessionToken);
      const entry = connectionId === undefined ? undefined : connections.get(connectionId);
      if (connectionId === undefined || entry === undefined) return { reason: NOT_BOUND_REASON };
      if (entry.copy !== undefined && isFresh(entry.copy)) return { token: entry.copy.token };

      if (entry.asking === undefined) {
        const asking = refresh(connectionId, entry, sessionToken).finally(() => {
          if (entry.asking === asking) entry.asking = undefined;
        });
        entry.asking = asking;
      }
      return entry.asking;
    },
  };
};
