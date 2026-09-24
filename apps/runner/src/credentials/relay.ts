/**
 * The runner's side of a credential request: a request from the socket is sent
 * to the controller on the current connection, and the answer is matched back
 * to it by request id.
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
 */
import * as Effect from "effect/Effect";
import * as Scope from "effect/Scope";
import type { CredentialAnswer, CredentialRequest } from "@hercule/protocol";
import { CREDENTIAL_DEADLINE_MS } from "./socket";
import type { CredentialAsk } from "./socket";

type Send = (frame: CredentialRequest) => Effect.Effect<void, unknown>;

export interface CredentialRelay {
  /**
   * Sends requests through `send` for as long as the scope is open. When the
   * scope closes, every pending request fails instead of waiting forever.
   */
  readonly attached: (send: Send) => Effect.Effect<void, never, Scope.Scope>;
  /** Sends a request to the controller and returns its answer. Rejects when no answer arrives. */
  readonly ask: (request: CredentialAsk) => Promise<CredentialAnswer>;
  /** Resolves the pending request that an answer from the controller belongs to. */
  readonly deliver: (answer: CredentialAnswer) => void;
}

export const makeCredentialRelay = (
  options: { readonly deadlineMs?: number } = {},
): CredentialRelay => {
  const deadlineMs = options.deadlineMs ?? CREDENTIAL_DEADLINE_MS;
  const waiting = new Map<
    string,
    { resolve: (answer: CredentialAnswer) => void; reject: (why: Error) => void }
  >();
  let sending: Send | undefined;

  const giveUp = (requestId: string, why: string): void => {
    const pending = waiting.get(requestId);
    if (pending === undefined) return;
    waiting.delete(requestId);
    pending.reject(new Error(why));
  };

  return {
    attached: (send) =>
      Effect.asVoid(
        Effect.acquireRelease(
          Effect.sync(() => {
            sending = send;
          }),
          () =>
            Effect.sync(() => {
              if (sending === send) sending = undefined;
              for (const requestId of [...waiting.keys()]) {
                giveUp(requestId, "the connection to the controller ended");
              }
            }),
        ),
      ),

    ask: async (request) => {
      const send = sending;
      // The socket turns this error into an empty reply, and git moves on to
      // the machine's own helpers.
      if (send === undefined) throw new Error("no controller connection to ask");
      const requestId = crypto.randomUUID();
      const answer = new Promise<CredentialAnswer>((resolve, reject) => {
        waiting.set(requestId, { resolve, reject });
        setTimeout(() => {
          giveUp(requestId, "the controller did not answer");
        }, deadlineMs).unref();
      });
      try {
        await Effect.runPromise(send({ _tag: "credentialRequest", requestId, ...request }));
      } catch (error) {
        waiting.delete(requestId);
        throw error;
      }
      return answer;
    },

    deliver: (answer) => {
      const pending = waiting.get(answer.requestId);
      if (pending === undefined) return;
      waiting.delete(answer.requestId);
      pending.resolve(answer);
    },
  };
};
