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
 *
 * The listening code is in `sign-in-return-listener.ts`, which this service
 * loads on the first `listen` or `wait`. Until then, `cancel` and
 * `cancelCurrent` do nothing, because there is no listener to end.
 */
export const makeSignInReturnLayer = (lifetimeMilliseconds: number): Layer.Layer<SignInReturn> =>
  Layer.effect(SignInReturn)(
    Effect.gen(function* () {
      let loading: Promise<SignInReturn["Service"]> | undefined;
      const loadListening = Effect.promise(
        () =>
          (loading ??= import("./sign-in-return-listener").then(({ makeLoopbackSignInReturn }) =>
            makeLoopbackSignInReturn(lifetimeMilliseconds),
          )),
      );
      /** Runs `operation` on the loaded listening code, or does nothing when it was never loaded. */
      const whenLoaded = (
        operation: (listening: SignInReturn["Service"]) => Effect.Effect<void>,
      ): Effect.Effect<void> =>
        Effect.suspend(() =>
          loading === undefined
            ? Effect.void
            : Effect.promise(() => loading!).pipe(Effect.flatMap(operation)),
        );

      const cancelCurrent = whenLoaded((listening) => listening.cancelCurrent);
      yield* Effect.addFinalizer(() => cancelCurrent);

      return SignInReturn.of({
        listen: loadListening.pipe(Effect.flatMap((listening) => listening.listen)),
        wait: (listenerId, authorizationUrl) =>
          loadListening.pipe(
            Effect.flatMap((listening) => listening.wait(listenerId, authorizationUrl)),
          ),
        cancel: (listenerId) => whenLoaded((listening) => listening.cancel(listenerId)),
        cancelCurrent,
      });
    }),
  );
