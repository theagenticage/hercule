/**
 * The part of the SignInReturn service that listens on loopback. It is a
 * module of its own, loaded the first time a sign-in starts, so that a launch
 * with no sign-in never loads it: main's startup file stays smaller, and the
 * first window needs none of this. `sign-in-return.ts` has the service, its
 * rules, and the code that loads this module.
 */
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { parseCallbackQuery, readAuthorizationState } from "@hercule/contract";
import * as Effect from "effect/Effect";
import type { SignInReturnListenOutcome, SignInReturnWaitOutcome } from "../ipc/contract";
import { AuthorizationUrlHasNoState, type SignInReturn } from "./sign-in-return";

/**
 * The page the browser shows after it returned. It holds no script and loads
 * nothing, and it does not say the sign-in worked: the return may be a refusal
 * or a code the controller then rejects.
 */
const RETURNED_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="color-scheme" content="light dark">
<title>Hercule</title>
</head>
<body>
<p>You can close this tab and return to Hercule.</p>
</body>
</html>
`;

/** A listener: its server, the `state` it waits for, and the waits that are pending. */
interface Listener {
  readonly id: string;
  readonly server: Server;
  /** The `state` a request must carry, or null until a wait names it. */
  expectedState: string | null;
  /** Answers each pending wait. Each one removes itself when it answers. */
  readonly answerWaits: Set<(outcome: SignInReturnWaitOutcome) => void>;
  /** Ends the listener when its time limit passes. Starts when the port is bound. */
  timer: ReturnType<typeof setTimeout> | undefined;
  ended: boolean;
}

/**
 * Splits a request target such as `/callback?code=a&state=b` into its path
 * and its raw query string, which is empty when the target has none. The
 * query is not re-encoded, because the controller checks the exact text the
 * browser sent.
 */
const splitRequestTarget = (target: string): { path: string; query: string } => {
  const queryStart = target.indexOf("?");
  return queryStart === -1
    ? { path: target, query: "" }
    : { path: target.slice(0, queryStart), query: target.slice(queryStart + 1) };
};

/** Answers `response` with a short plain-text refusal, so that the listener shows nothing of itself. */
const answerNotFound = (response: ServerResponse): void => {
  response.writeHead(404, {
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
    Connection: "close",
  });
  response.end("Not found");
};

/**
 * Checks that a callback query is a well-formed return (`parseCallbackQuery`
 * of the contract) of the sign-in whose `state` is `expectedState`. The
 * controller refuses a malformed return without using the sign-in up, so the
 * listener must not end its wait on one.
 */
const isReturnOfState = (query: string, expectedState: string | null): boolean => {
  const callback = parseCallbackQuery(query);
  return callback._tag === "Callback" && callback.state === expectedState;
};

/** Binds `server` to 127.0.0.1 on a port the system picks, and returns the port, or null when it cannot. */
const bindToLoopback = (server: Server): Promise<number | null> =>
  new Promise((resolve) => {
    server.once("error", () => resolve(null));
    server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port));
  });

/**
 * Builds the service's operations on a real loopback port. A listener lasts at
 * most `lifetimeMilliseconds` from the moment it is bound. Ending the service
 * is the caller's job: it calls `cancelCurrent`.
 */
export const makeLoopbackSignInReturn = (lifetimeMilliseconds: number): SignInReturn["Service"] => {
  let current: Listener | null = null;

  /** Ends `listener` once: closes its port, and answers its pending waits with `outcome`. */
  const end = (listener: Listener, outcome: SignInReturnWaitOutcome): void => {
    if (listener.ended) return;
    listener.ended = true;
    clearTimeout(listener.timer);
    if (current === listener) current = null;
    // `close` stops accepting at once. A connection that is answering
    // finishes; one that is idle goes now.
    listener.server.close();
    listener.server.closeIdleConnections();
    for (const answerWait of [...listener.answerWaits]) answerWait(outcome);
  };

  const answerRequest = (
    listener: Listener,
    request: IncomingMessage,
    response: ServerResponse,
  ): void => {
    const { path, query } = splitRequestTarget(request.url ?? "");
    const matches =
      request.method === "GET" &&
      path === "/callback" &&
      isReturnOfState(query, listener.expectedState);
    if (!matches) {
      answerNotFound(response);
      return;
    }
    response.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      Connection: "close",
    });
    response.end(RETURNED_PAGE);
    end(listener, { _tag: "received", callbackQuery: query });
  };

  const listen = Effect.promise(async (): Promise<SignInReturnListenOutcome> => {
    if (current !== null) end(current, { _tag: "cancelled" });
    const listener: Listener = {
      id: randomUUID(),
      server: createServer((request, response) => answerRequest(listener, request, response)),
      expectedState: null,
      answerWaits: new Set(),
      timer: undefined,
      ended: false,
    };
    current = listener;
    const port = await bindToLoopback(listener.server);
    if (port === null) {
      end(listener, { _tag: "cancelled" });
      return { _tag: "unavailable" };
    }
    // A newer `listen` ended this listener while it was binding.
    if (listener.ended) return { _tag: "unavailable" };
    listener.timer = setTimeout(() => end(listener, { _tag: "timed-out" }), lifetimeMilliseconds);
    return {
      _tag: "listening",
      listenerId: listener.id,
      redirectUri: `http://127.0.0.1:${String(port)}/callback`,
    };
  });

  const wait = (listenerId: string, authorizationUrl: string) =>
    Effect.gen(function* () {
      const state = readAuthorizationState(authorizationUrl);
      if (state === undefined) {
        return yield* new AuthorizationUrlHasNoState({
          message: "the authorization URL has no state, so no return could be matched to it",
        });
      }
      const listener = current;
      if (listener === null || listener.id !== listenerId) {
        return { _tag: "cancelled" } as const;
      }
      listener.expectedState = state;
      return yield* Effect.callback<SignInReturnWaitOutcome>((resume) => {
        const answerWait = (outcome: SignInReturnWaitOutcome) => {
          listener.answerWaits.delete(answerWait);
          resume(Effect.succeed(outcome));
        };
        listener.answerWaits.add(answerWait);
      });
    });

  const cancel = (listenerId: string) =>
    Effect.sync(() => {
      if (current !== null && current.id === listenerId) end(current, { _tag: "cancelled" });
    });

  const cancelCurrent = Effect.sync(() => {
    if (current !== null) end(current, { _tag: "cancelled" });
  });

  return { listen, wait, cancel, cancelCurrent };
};
