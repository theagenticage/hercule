/**
 * The browser sign-in of an attempt (private to this folder): the `signing-in`
 * phase of `url-server-attempt.ts`. It starts a listener for the browser's
 * return when the app has one, asks the controller for the authorization
 * address, waits for the return or for a pasted address, finishes the sign-in,
 * and closes the listener whichever way the phase is left.
 *
 * The attempt owns the phases and the record the dialog follows. This module
 * owns what only the browser sign-in holds: the listener and the steps. It
 * reaches the attempt through a `BrowserSignInHost`, so a reply that comes back
 * after the attempt left the phase changes nothing.
 */
import {
  InvalidStateDetails,
  parseCallbackQuery,
  type McpServerSignInStart,
} from "@hercule/contract";
import { Schema } from "effect";
import type { HerculeClient } from "../client";
import { ApiError, readErrorMessage, readValidationIssues } from "../errors";
import { buildPastedRedirectUri } from "../mcp-server-sign-in";
import {
  BROWSER_SIGN_IN_UNSUPPORTED,
  describePasteRefusal,
  describeSignInRefusal,
  type SignInRefusalReason,
} from "./sign-in-words";

/**
 * What an app that catches the browser's return itself (the desktop app) gives
 * the attempts. The web app gives none, and its sign-in uses the paste alone.
 */
export interface BrowserSignInPort {
  /**
   * Starts a listener for the browser's return. Answers `listening` with the
   * address the browser returns to, or `unavailable` when it cannot listen,
   * in which case the attempt asks for the paste.
   */
  readonly listen: () => Promise<
    | { readonly kind: "listening"; readonly listenerId: string; readonly redirectUri: string }
    | { readonly kind: "unavailable" }
  >;
  /**
   * Waits until the browser comes back to the listener `listenerId` with the
   * `state` of `authorizationUrl`. `received` carries the query the browser
   * sent, which goes to `mcpServer.finishSignIn` as it is.
   */
  readonly wait: (
    listenerId: string,
    authorizationUrl: string,
  ) => Promise<
    | { readonly kind: "received"; readonly callbackQuery: string }
    | { readonly kind: "cancelled" }
    | { readonly kind: "timed-out" }
  >;
  /** Closes the listener `listenerId`, which ends its `wait` with `cancelled`. */
  readonly cancel: (listenerId: string) => Promise<void>;
  /** Opens `url` in the user's browser. Fails when the browser cannot be opened. */
  readonly open: (url: string) => Promise<void>;
}

/**
 * Where the browser sign-in of an attempt is.
 *
 * - `starting`: the listener is starting and the controller is preparing the sign-in.
 * - `waiting`: the authorization address is out and the browser has not come back. The user opens the browser by pressing the button beside the host.
 * - `finishing`: the browser's answer is with the controller.
 * - `refused`: the sign-in ended without a sign-in. `message` says why and what to do.
 */
export type SignInStep =
  | { readonly kind: "starting" }
  | {
      readonly kind: "waiting";
      /** The address the browser opens. It is an http or https address without credentials, so an app may use it as a link. */
      readonly authorizationUrl: string;
      /** The host that asks for the approval, shown before the browser is opened. */
      readonly approvalHost: string;
      /** The time after which the controller no longer accepts the answer. */
      readonly expiresAt: string;
      /** `listener`: the app catches the browser's return itself. `paste`: the user pastes the address the browser ended on. */
      readonly returnBy: "listener" | "paste";
      /** True once the user asked to open the sign-in page (`openPage`). */
      readonly opened: boolean;
      /** Why the app could not open the browser, or `null`. */
      readonly openError: string | null;
      /** Why the last pasted address was not accepted, or `null`. */
      readonly pasteProblem: string | null;
    }
  | { readonly kind: "finishing" }
  | {
      readonly kind: "refused";
      readonly reason: SignInRefusalReason;
      readonly message: string;
    };

/** What the attempt shows while it signs in through the browser. */
export interface SigningInState {
  readonly kind: "signing-in";
  readonly mcpServerId: string;
  readonly step: SignInStep;
}

/** What a form shows when the controller says no sign-in through the browser works for the server, so only a pasted token does. */
export interface SignInUnsupportedProblem {
  readonly kind: "sign-in-unsupported";
  readonly message: string;
}

/** The phase of an attempt that signs in through the browser. */
export interface SigningInPhase {
  readonly kind: "signing-in";
  state: SigningInState;
  /** Returns the attempt to the phase the sign-in started from. `problem` is shown with that phase's form. */
  readonly returnTo: (problem: SignInUnsupportedProblem | null) => void;
  /** The listener of the browser's return, or `null` while there is none. */
  listenerId: string | null;
  release: () => void;
}

/** What the browser sign-in needs from the attempt that owns its phase. */
export interface BrowserSignInHost {
  readonly client: HerculeClient;
  /** How the app catches the browser's return, or `undefined` when it cannot (the paste is used). */
  readonly port: BrowserSignInPort | undefined;
  /** Returns true while `owner` is the attempt's current phase. */
  readonly isCurrent: (owner: SigningInPhase) => boolean;
  /** Makes `owner` the attempt's phase, after releasing what the phase that is left holds. */
  readonly enter: (owner: SigningInPhase) => void;
  /** Shows `state` for `owner`, unless the attempt left the phase meanwhile. */
  readonly show: (owner: SigningInPhase, state: SigningInState) => void;
  /** Ends the attempt with `gone` (the server was deleted) or `moved` (a Connection reaches it now). */
  readonly end: (reason: "gone" | "moved", message: string | null) => void;
  /** Follows the signed-in server. */
  readonly follow: () => void;
  /** Watches the list of servers while `owner` waits. Returns the function that stops it. */
  readonly watchCatalogue: (owner: SigningInPhase, mcpServerId: string) => () => void;
  /** Reads the server's page and the list again, so whoever shows them sees what a write did. */
  readonly readAgainAfterWrite: (mcpServerId: string) => void;
}

/** The moves of the browser sign-in, which the attempt calls. */
export interface BrowserSignIn {
  /**
   * Enters the `signing-in` phase for the server `mcpServerId` and runs the
   * sign-in to the point where it waits for the browser or the paste, or fails.
   * It resolves once the waiting step shows or the sign-in failed. `returnTo`
   * brings the attempt back to where it started.
   */
  readonly start: (mcpServerId: string, returnTo: SigningInPhase["returnTo"]) => Promise<void>;
  /** Finishes the waiting sign-in of `owner` with the pasted address. Does nothing unless `owner` is waiting. */
  readonly finishByPaste: (owner: SigningInPhase, pasted: string) => Promise<void>;
  /** Marks the sign-in page as opened, and opens it when the app has a port. Does nothing unless `owner` is waiting. */
  readonly openPage: (owner: SigningInPhase) => Promise<void>;
}

/** What a failed sign-in step leads to. */
type SignInFailure =
  /** The server was deleted, or is reached with a Connection now: the attempt has nothing left to do. */
  | { readonly kind: "ended"; readonly reason: "gone" | "moved"; readonly message: string | null }
  /** Only a pasted token works for this server. */
  | { readonly kind: "unsupported" }
  /** The controller says the text sent is not a redirect answer. */
  | { readonly kind: "invalid"; readonly message: string }
  /** The sign-in ended: `message` says why and what to do. */
  | {
      readonly kind: "refused";
      readonly reason: SignInRefusalReason;
      readonly message: string;
    };

const isInvalidStateDetails = Schema.is(InvalidStateDetails);

const refused = (reason: SignInRefusalReason, detail: string): SignInFailure => ({
  kind: "refused",
  reason,
  message: describeSignInRefusal(reason, detail),
});

/** Returns the host of the controller's authorization address, or `null` when the address must not be opened: it is not an http or https address, or it carries credentials. */
const readOpenableAddressHost = (authorizationUrl: string): string | null => {
  if (!URL.canParse(authorizationUrl)) return null;
  const { protocol, host, username, password } = new URL(authorizationUrl);
  const isWebAddress = protocol === "http:" || protocol === "https:";
  return isWebAddress && host !== "" && username === "" && password === "" ? host : null;
};

/** Turns the failure of `startSignIn` or `finishSignIn` into what the attempt does next. */
const readSignInFailure = (error: unknown): SignInFailure => {
  if (!(error instanceof ApiError)) return refused("failed", readErrorMessage(error));
  if (error.code === "not_found") return { kind: "ended", reason: "gone", message: null };
  if (error.code === "validation") {
    // The controller's own words for what is wrong are in the first issue: the message above them is generic.
    return {
      kind: "invalid",
      message: readValidationIssues(error)?.[0]?.message ?? readErrorMessage(error),
    };
  }
  if (error.code !== "invalid_state") return refused("failed", readErrorMessage(error));
  if (!isInvalidStateDetails(error.details)) {
    // No details: the server is reached with a Connection now.
    return { kind: "ended", reason: "moved", message: error.message };
  }
  switch (error.details.reason) {
    case "sign-in-unsupported":
      return { kind: "unsupported" };
    case "sign-in-expired":
    case "sign-in-refused":
    case "source-unreadable":
      return refused(error.details.reason, error.message);
    default:
      return refused("failed", error.message);
  }
};

/** Returns the browser sign-in of the attempt that `host` stands for. */
export const createBrowserSignIn = (host: BrowserSignInHost): BrowserSignIn => {
  const { client, port } = host;

  /** Closes the listener of the phase's browser return, and forgets it. */
  const retireListener = (owner: SigningInPhase): void => {
    const { listenerId } = owner;
    owner.listenerId = null;
    if (listenerId !== null) void port?.cancel(listenerId).catch(() => {});
  };

  /** Shows what a failed sign-in step leads to, for the sign-in phase `owner`. */
  const showFailure = (owner: SigningInPhase, failure: SignInFailure): void => {
    if (!host.isCurrent(owner)) return;
    switch (failure.kind) {
      case "ended":
        host.end(failure.reason, failure.message);
        return;
      case "unsupported":
        owner.returnTo({ kind: "sign-in-unsupported", message: BROWSER_SIGN_IN_UNSUPPORTED });
        return;
      case "refused":
        retireListener(owner);
        host.show(owner, {
          kind: "signing-in",
          mcpServerId: owner.state.mcpServerId,
          step: { kind: "refused", reason: failure.reason, message: failure.message },
        });
        return;
      case "invalid":
        // Only a pasted address is judged by its text, and `finish` handles that. Any other
        // validation failure is a request the controller refused.
        showFailure(owner, refused("failed", failure.message));
    }
  };

  /**
   * Sends what the browser came back with to `mcpServer.finishSignIn` and
   * follows the signed-in server. `waiting` is the step to return to when the
   * controller finds the pasted text is not a redirect answer, or `null` when
   * the text came from the listener.
   */
  const finish = async (
    owner: SigningInPhase,
    callbackQuery: string,
    waiting: Extract<SignInStep, { kind: "waiting" }> | null,
  ): Promise<void> => {
    const id = owner.state.mcpServerId;
    host.show(owner, { kind: "signing-in", mcpServerId: id, step: { kind: "finishing" } });
    let failure: unknown;
    let finished = false;
    try {
      await client.mcpServer.finishSignIn({ params: { id }, payload: { callbackQuery } });
      finished = true;
    } catch (error) {
      failure = error;
    }
    // Whoever shows the server reads it again, whether or not this dialog is still open.
    if (finished) host.readAgainAfterWrite(id);
    if (!host.isCurrent(owner)) return;
    if (finished) {
      host.follow();
      return;
    }
    const result = readSignInFailure(failure);
    if (result.kind === "invalid" && waiting !== null) {
      host.show(owner, {
        kind: "signing-in",
        mcpServerId: id,
        step: { ...waiting, returnBy: "paste", pasteProblem: result.message },
      });
      return;
    }
    showFailure(owner, result);
  };

  /** Waits for the browser to come back to the listener, then finishes the sign-in or shows why it did not. Runs beside the waiting step, so a pasted address or a cancel can take over. */
  const awaitReturn = async (
    owner: SigningInPhase,
    listenerId: string,
    authorizationUrl: string,
  ): Promise<void> => {
    if (port === undefined) return;
    const outcome = await port
      .wait(listenerId, authorizationUrl)
      .catch((): { kind: "cancelled" } => ({ kind: "cancelled" }));
    // A paste, a cancel, a close or a newer sign-in took this listener over.
    if (!host.isCurrent(owner) || owner.listenerId !== listenerId) return;
    owner.listenerId = null;
    switch (outcome.kind) {
      case "received":
        await finish(owner, outcome.callbackQuery, null);
        return;
      case "timed-out":
        showFailure(owner, refused("timed-out", ""));
        return;
      case "cancelled":
        showFailure(
          owner,
          refused("failed", "The app stopped waiting for the browser. Start again."),
        );
    }
  };

  const start = async (id: string, returnTo: SigningInPhase["returnTo"]): Promise<void> => {
    const owner: SigningInPhase = {
      kind: "signing-in",
      state: { kind: "signing-in", mcpServerId: id, step: { kind: "starting" } },
      returnTo,
      listenerId: null,
      release: () => {},
    };
    host.enter(owner);
    const stopWatching = host.watchCatalogue(owner, id);
    owner.release = () => {
      stopWatching();
      retireListener(owner);
    };

    let started: McpServerSignInStart;
    try {
      const listening = port === undefined ? undefined : await port.listen();
      let redirectUri: string;
      if (listening?.kind === "listening") {
        if (!host.isCurrent(owner)) {
          void port?.cancel(listening.listenerId).catch(() => {});
          return;
        }
        owner.listenerId = listening.listenerId;
        redirectUri = listening.redirectUri;
      } else {
        if (!host.isCurrent(owner)) return;
        redirectUri = buildPastedRedirectUri();
      }
      started = await client.mcpServer.startSignIn({ params: { id }, payload: { redirectUri } });
    } catch (error) {
      showFailure(owner, readSignInFailure(error));
      return;
    }
    if (!host.isCurrent(owner)) return;
    const approvalHost = readOpenableAddressHost(started.authorizationUrl);
    if (approvalHost === null) {
      showFailure(
        owner,
        refused(
          "failed",
          "The sign-in address the controller gave is not a web address Hercule can open, so nothing was opened. Try again later, or paste a token instead.",
        ),
      );
      return;
    }
    const { listenerId } = owner;
    // The wait starts when the step shows, so a return that comes at once finds it.
    host.show(owner, {
      kind: "signing-in",
      mcpServerId: id,
      step: {
        kind: "waiting",
        authorizationUrl: started.authorizationUrl,
        approvalHost,
        expiresAt: started.expiresAt,
        returnBy: listenerId === null ? "paste" : "listener",
        opened: false,
        openError: null,
        pasteProblem: null,
      },
    });
    if (listenerId !== null) void awaitReturn(owner, listenerId, started.authorizationUrl);
  };

  const finishByPaste = async (owner: SigningInPhase, pasted: string): Promise<void> => {
    if (owner.state.step.kind !== "waiting") return;
    const { step, mcpServerId: id } = owner.state;
    const parsed = parseCallbackQuery(pasted);
    if (parsed._tag === "Refused") {
      host.show(owner, {
        kind: "signing-in",
        mcpServerId: id,
        step: { ...step, pasteProblem: describePasteRefusal(parsed.reason) },
      });
      return;
    }
    // The pasted address replaces the listener: closing it ends the wait, which then changes nothing.
    retireListener(owner);
    await finish(owner, pasted.trim(), step);
  };

  const openPage = async (owner: SigningInPhase): Promise<void> => {
    if (owner.state.step.kind !== "waiting") return;
    const { step: waiting, mcpServerId: id } = owner.state;
    // Marked before the call, so a second press while the browser opens reads "Open again" too.
    host.show(owner, {
      kind: "signing-in",
      mcpServerId: id,
      step: { ...waiting, opened: true, openError: null },
    });
    if (port === undefined) return;
    let openError: string | null = null;
    try {
      await port.open(waiting.authorizationUrl);
    } catch (error) {
      openError = readErrorMessage(error);
    }
    const { state } = owner;
    if (
      !host.isCurrent(owner) ||
      state.step.kind !== "waiting" ||
      state.step.openError === openError
    ) {
      return;
    }
    host.show(owner, { kind: "signing-in", mcpServerId: id, step: { ...state.step, openError } });
  };

  return { start, finishByPaste, openPage };
};
