/**
 * The SignInReturn service: catches the browser's return from an MCP server's
 * sign-in (spec 17, "The IPC contract" and "Settings > MCP servers").
 *
 * The sign-in sends the user's browser to the MCP server's authorization
 * page, and that page sends the browser back to a redirect URI the app named.
 * The app names `http://127.0.0.1:<port>/callback`, and main listens there:
 *
 * - Main listens only while a sign-in runs. A usual launch has no server,
 *   socket or timer of this service.
 * - It listens on 127.0.0.1 and never on another interface, on a port the
 *   system picks.
 * - There is at most one listener. Starting a listener ends the one before.
 * - The only request it answers is `GET /callback` carrying the `state` of
 *   the sign-in it waits for, so a stray request, such as a port scan or
 *   another program, can neither end the wait nor inject a result.
 * - A listener ends after the browser returned, after it was cancelled, after
 *   10 minutes, and when the app quits.
 *
 * Main reads nothing in the returning request but its `state`. The renderer
 * gets the raw query string and hands it to the controller, which checks it.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { SignInReturnListenOutcome, SignInReturnWaitOutcome } from "../ipc/contract";

/** How long a wait lasts before it answers `timed-out`: 10 minutes. */
export const SIGN_IN_RETURN_WAIT_MILLISECONDS = 10 * 60 * 1000;

/** The renderer asked to wait for a sign-in whose authorization URL has no `state`. */
export class AuthorizationUrlHasNoState extends Data.TaggedError("AuthorizationUrlHasNoState")<{
  readonly message: string;
}> {}

/** Catches the browser's return from a sign-in, on 127.0.0.1. */
export class SignInReturn extends Context.Service<
  SignInReturn,
  {
    /**
     * Starts a listener on 127.0.0.1 and returns its id and its redirect URI.
     * Ends the listener before it, if any: that listener's wait answers
     * `cancelled`. Returns `unavailable` when no port can be bound.
     */
    readonly listen: Effect.Effect<SignInReturnListenOutcome>;

    /**
     * Waits for the browser to return to the listener `listenerId`, for the
     * sign-in that `authorizationUrl` starts, and ends the listener when it
     * answers. Returns `received` with the raw query string of the request
     * whose `state` matches, `timed-out` when none came in time, and
     * `cancelled` when `cancel` or a newer `listen` ended the listener, or
     * when no such listener exists. Fails with AuthorizationUrlHasNoState
     * when no request could ever match.
     */
    readonly wait: (
      listenerId: string,
      authorizationUrl: string,
    ) => Effect.Effect<SignInReturnWaitOutcome, AuthorizationUrlHasNoState>;

    /** Ends the listener `listenerId`, and answers its pending wait `cancelled`. Does nothing when there is no such listener. */
    readonly cancel: (listenerId: string) => Effect.Effect<void>;
  }
>()("hercule/desktop/SignInReturn") {}

/** The page the browser shows after it returned. It holds no script and loads nothing. */
const RETURNED_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="color-scheme" content="light dark">
<title>Signed in</title>
</head>
<body>
<p>Signed in. You can close this tab and return to Hercule.</p>
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

/** Binds `server` to 127.0.0.1 on a port the system picks, and returns the port, or null when it cannot. */
const bindToLoopback = (server: Server): Promise<number | null> =>
  new Promise((resolve) => {
    server.once("error", () => resolve(null));
    server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port));
  });

/**
 * Builds the SignInReturn service. A wait lasts at most `waitMilliseconds`;
 * the app passes `SIGN_IN_RETURN_WAIT_MILLISECONDS`, and a test passes less.
 */
export const makeSignInReturnLayer = (waitMilliseconds: number): Layer.Layer<SignInReturn> =>
  Layer.effect(SignInReturn)(
    Effect.gen(function* () {
      let current: Listener | null = null;

      /** Ends `listener` once: closes its port, and answers its pending waits with `outcome`. */
      const end = (listener: Listener, outcome: SignInReturnWaitOutcome): void => {
        if (listener.ended) return;
        listener.ended = true;
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
          listener.expectedState !== null &&
          new URLSearchParams(query).get("state") === listener.expectedState;
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
        return {
          _tag: "listening",
          listenerId: listener.id,
          redirectUri: `http://127.0.0.1:${String(port)}/callback`,
        };
      });

      const wait = (listenerId: string, authorizationUrl: string) =>
        Effect.gen(function* () {
          const state = new URL(authorizationUrl).searchParams.get("state");
          if (state === null || state === "") {
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
              clearTimeout(timer);
              listener.answerWaits.delete(answerWait);
              resume(Effect.succeed(outcome));
            };
            const timer = setTimeout(() => end(listener, { _tag: "timed-out" }), waitMilliseconds);
            listener.answerWaits.add(answerWait);
            // The renderer stopped waiting: the timer must not outlive it.
            return Effect.sync(() => {
              clearTimeout(timer);
              listener.answerWaits.delete(answerWait);
            });
          });
        });

      const cancel = (listenerId: string) =>
        Effect.sync(() => {
          if (current !== null && current.id === listenerId) end(current, { _tag: "cancelled" });
        });

      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          if (current !== null) end(current, { _tag: "cancelled" });
        }),
      );

      return SignInReturn.of({ listen, wait, cancel });
    }),
  );
