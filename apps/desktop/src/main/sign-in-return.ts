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
 * - The only request it answers is `GET /callback` carrying exactly one
 *   `state`, the one of the sign-in it waits for, and exactly one of `code`
 *   and `error`. A stray request, such as a port scan or another program, can
 *   neither end the wait nor inject a result, and a malformed return does not
 *   use up the listener.
 * - A listener ends after the browser returned, after it was cancelled, 10
 *   minutes after it started listening (also when no one ever waits for it),
 *   when the page that started it goes away (`cancelWhenPageEnds`), and when
 *   the app quits.
 *
 * Main reads nothing in the returning request but those three names. The
 * renderer gets the raw query string and hands it to the controller, which
 * checks it.
 */
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { parseCallbackQuery, readAuthorizationState } from "@hercule/contract";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { SignInReturnListenOutcome, SignInReturnWaitOutcome } from "../ipc/contract";

/** How long a listener lasts from the moment it is bound before it answers `timed-out`: 10 minutes. */
export const SIGN_IN_RETURN_LIFETIME_MILLISECONDS = 10 * 60 * 1000;

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
     * `cancelled`. Returns `unavailable` when no port can be bound. The
     * listener ends by itself after the time limit, whether or not `wait`
     * is ever called.
     */
    readonly listen: Effect.Effect<SignInReturnListenOutcome>;

    /**
     * Waits for the browser to return to the listener `listenerId`, for the
     * sign-in that `authorizationUrl` starts, and ends the listener when it
     * answers. Returns `received` with the raw query string of the request
     * whose `state` matches, `timed-out` when none came before the listener's
     * time limit, and `cancelled` when `cancel` or a newer `listen` ended the
     * listener, or when no such listener exists. Fails with
     * AuthorizationUrlHasNoState when no request could ever match.
     */
    readonly wait: (
      listenerId: string,
      authorizationUrl: string,
    ) => Effect.Effect<SignInReturnWaitOutcome, AuthorizationUrlHasNoState>;

    /** Ends the listener `listenerId`, and answers its pending wait `cancelled`. Does nothing when there is no such listener. */
    readonly cancel: (listenerId: string) => Effect.Effect<void>;

    /** Ends the listener there is, whichever it is, as `cancel` does. Does nothing when there is none. */
    readonly cancelCurrent: Effect.Effect<void>;
  }
>()("hercule/desktop/SignInReturn") {}

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

/** The events of a page (an Electron `WebContents`) that `cancelWhenPageEnds` listens to. */
export interface PageEvents {
  once(event: "destroyed", listener: () => void): unknown;
  on(event: "render-process-gone", listener: () => void): unknown;
  on(
    event: "did-start-navigation",
    listener: (details: {
      readonly isMainFrame: boolean;
      readonly isSameDocument: boolean;
    }) => void,
  ): unknown;
}

/**
 * Calls `cancel` when `page` is destroyed, its renderer process is gone, or
 * its main frame starts a navigation to another document (a reload included).
 * A sign-in's listener is for the page that started it: once the page ends,
 * no one is left to use the return, so the port must close. Nothing else
 * ends a listener when the page goes away, because a wait that main answers
 * over IPC is not interrupted by it.
 */
export const cancelWhenPageEnds = (page: PageEvents, cancel: () => void): void => {
  page.once("destroyed", cancel);
  page.on("render-process-gone", cancel);
  page.on("did-start-navigation", (details) => {
    if (details.isMainFrame && !details.isSameDocument) cancel();
  });
};

/**
 * Builds the SignInReturn service. A listener lasts at most `lifetimeMilliseconds`
 * from the moment it is bound; the app passes `SIGN_IN_RETURN_LIFETIME_MILLISECONDS`,
 * and a test passes less.
 */
export const makeSignInReturnLayer = (lifetimeMilliseconds: number): Layer.Layer<SignInReturn> =>
  Layer.effect(SignInReturn)(
    Effect.gen(function* () {
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
        // Loaded here, so a launch with no sign-in never loads the module.
        const { createServer } = await import("node:http");
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
        listener.timer = setTimeout(
          () => end(listener, { _tag: "timed-out" }),
          lifetimeMilliseconds,
        );
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

      yield* Effect.addFinalizer(() => cancelCurrent);

      return SignInReturn.of({ listen, wait, cancel, cancelCurrent });
    }),
  );
