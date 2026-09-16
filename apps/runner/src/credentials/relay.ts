/**
 * The runner's half of a credential exchange: a question from the socket goes
 * out on whichever connection is up, and the answer is found again by its
 * request id.
 *
 * One relay per daemon rather than one per connection, because the socket
 * outlives any one of them: the helper asks the daemon, not the connection.
 * Nothing is held beyond the reply it belongs to.
 *
 * A question nobody answered - no connection, a connection that dropped, a
 * controller that took too long - is an absent answer and never a refusal: a
 * refusal is something the controller decided, and reporting one nobody made
 * would tell the user their credential was denied when it was never asked for.
 */
import * as Effect from "effect/Effect";
import * as Scope from "effect/Scope";
import type { CredentialAnswer, CredentialRequest } from "@hydra/protocol";
import { CREDENTIAL_DEADLINE_MS } from "./socket";
import type { CredentialAsk } from "./socket";

type Send = (frame: CredentialRequest) => Effect.Effect<void, unknown>;

export interface CredentialRelay {
  /**
   * Holds the connection for as long as its scope is open. Whatever was waiting
   * when it closes is given up on rather than left hanging.
   */
  readonly attached: (send: Send) => Effect.Effect<void, never, Scope.Scope>;
  /** What the socket calls. Rejects when nothing answered. */
  readonly ask: (request: CredentialAsk) => Promise<CredentialAnswer>;
  /** What the connection calls when the controller answers. */
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
      // No connection, no answer: the socket turns this into an empty one, and
      // git falls through to the machine's own helpers.
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
