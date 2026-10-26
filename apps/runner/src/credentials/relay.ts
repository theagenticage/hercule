/**
 * The runner's side of a request to the controller that a process on this
 * machine waits for: git's credential request and the `gh` shim's GitHub token
 * request. A request from the socket is sent to the controller on the current
 * connection, and the answer is matched back to it by request id.
 *
 * There is one relay per daemon rather than one per connection, because the
 * socket outlives any single connection to the controller. A pending request
 * is forgotten as soon as it is answered or given up on.
 *
 * A request that gets no answer (no connection, a dropped connection, or a
 * controller that took too long) fails with an error, and is never reported as
 * a denial. Only the controller can deny a credential; reporting a denial it
 * never made would tell the user their credential was refused when the
 * controller was never asked.
 *
 * A GitHub token request is also never sent to a controller whose hello did
 * not list `GITHUB_TOKEN_CAPABILITY`: such a controller cannot decode the
 * frame and would close the connection.
 */
import * as Effect from "effect/Effect";
import * as Scope from "effect/Scope";
import type {
  CredentialAnswer,
  CredentialRequest,
  GithubTokenAnswer,
  GithubTokenRequest,
} from "@hercule/protocol";
import { CREDENTIAL_DEADLINE_MS, GITHUB_TOKEN_ASK_DEADLINE_MS } from "./socket";
import type { CredentialAsk } from "./socket";

type Send = (frame: CredentialRequest | GithubTokenRequest) => Effect.Effect<void, unknown>;

export interface CredentialRelay {
  /**
   * Sends requests through `send` for as long as the scope is open. When the
   * scope closes, every pending request fails instead of waiting forever.
   * `answersGithubTokens` is whether the controller on this connection listed
   * `GITHUB_TOKEN_CAPABILITY` in its hello.
   */
  readonly attachConnection: (
    send: Send,
    controller: { readonly answersGithubTokens: boolean },
  ) => Effect.Effect<void, never, Scope.Scope>;
  /** Sends a request to the controller and returns its answer. Rejects when no answer arrives. */
  readonly ask: (request: CredentialAsk) => Promise<CredentialAnswer>;
  /**
   * Sends a request for a session's GitHub token and returns the controller's
   * answer, a token or a refusal. Rejects when no answer arrives, and when
   * the controller does not list `GITHUB_TOKEN_CAPABILITY`.
   */
  readonly askGithubToken: (sessionToken: string) => Promise<GithubTokenAnswer>;
  /** Resolves the pending request that an answer from the controller belongs to. */
  readonly deliver: (answer: CredentialAnswer | GithubTokenAnswer) => void;
}

/** A request waiting for its answer. The tag keeps an answer of one kind from resolving a request of the other. */
interface Pending {
  readonly answerTag: "credentialAnswer" | "githubTokenAnswer";
  readonly resolve: (answer: CredentialAnswer | GithubTokenAnswer) => void;
  readonly reject: (why: Error) => void;
}

/**
 * Creates the relay. `options.deadlineMs` replaces how long every kind of
 * request waits for its answer. Without it, git's credential request waits
 * `CREDENTIAL_DEADLINE_MS` and the GitHub token request the shorter
 * `GITHUB_TOKEN_ASK_DEADLINE_MS`.
 */
export const makeCredentialRelay = (
  options: { readonly deadlineMs?: number } = {},
): CredentialRelay => {
  const waiting = new Map<string, Pending>();
  let sending: { readonly send: Send; readonly answersGithubTokens: boolean } | undefined;

  const giveUp = (requestId: string, why: string): void => {
    const pending = waiting.get(requestId);
    if (pending === undefined) return;
    waiting.delete(requestId);
    pending.reject(new Error(why));
  };

  /**
   * Sends the frame `buildFrame` makes on the current connection and returns
   * the answer with the same request id. Rejects when there is no connection,
   * the send fails, or no answer arrives within `deadlineMs`.
   */
  const request = async <Answer extends CredentialAnswer | GithubTokenAnswer>(
    answerTag: Answer["_tag"],
    deadlineMs: number,
    buildFrame: (requestId: string) => CredentialRequest | GithubTokenRequest,
  ): Promise<Answer> => {
    // The socket turns this error into an empty reply, and git moves on to
    // the machine's own helpers.
    if (sending === undefined) throw new Error("no controller connection to ask");
    const { send } = sending;
    const requestId = crypto.randomUUID();
    const answer = new Promise<Answer>((resolve, reject) => {
      waiting.set(requestId, { answerTag, resolve: resolve as Pending["resolve"], reject });
      setTimeout(() => {
        giveUp(requestId, "the controller did not answer");
      }, deadlineMs).unref();
    });
    try {
      await Effect.runPromise(send(buildFrame(requestId)));
    } catch (error) {
      waiting.delete(requestId);
      throw error;
    }
    return answer;
  };

  return {
    attachConnection: (send, { answersGithubTokens }) =>
      Effect.asVoid(
        Effect.acquireRelease(
          Effect.sync(() => {
            const attached = { send, answersGithubTokens };
            sending = attached;
            return attached;
          }),
          (attached) =>
            Effect.sync(() => {
              if (sending === attached) sending = undefined;
              for (const requestId of [...waiting.keys()]) {
                giveUp(requestId, "the connection to the controller ended");
              }
            }),
        ),
      ),

    ask: (credentialAsk) =>
      request<CredentialAnswer>(
        "credentialAnswer",
        options.deadlineMs ?? CREDENTIAL_DEADLINE_MS,
        (requestId) => ({
          _tag: "credentialRequest",
          requestId,
          ...credentialAsk,
        }),
      ),

    askGithubToken: async (sessionToken) => {
      if (sending?.answersGithubTokens !== true) {
        throw new Error("the controller does not answer GitHub token requests");
      }
      return request<GithubTokenAnswer>(
        "githubTokenAnswer",
        options.deadlineMs ?? GITHUB_TOKEN_ASK_DEADLINE_MS,
        (requestId) => ({
          _tag: "githubTokenRequest",
          requestId,
          sessionToken,
        }),
      );
    },

    deliver: (answer) => {
      const pending = waiting.get(answer.requestId);
      if (pending === undefined || pending.answerTag !== answer._tag) return;
      waiting.delete(answer.requestId);
      pending.resolve(answer);
    },
  };
};
