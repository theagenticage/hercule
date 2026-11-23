/**
 * The two dialogs that write a server added by URL: Add by URL, and the token
 * form (the page's "Replace token…", and the "Sign in…" of a thread line and
 * of the band). Both are an attempt that runs the same way:
 *
 * 1. `form`: the user fills the fields. Nothing was sent.
 * 2. `writing`: the one write of the attempt runs (`mcpServer.create` or
 *    `mcpServer.setToken`). A second submit meanwhile does nothing.
 * 3. `following`: the controller acknowledged the write. The attempt now
 *    reads the server by its id and follows it, because the controller checks
 *    the server after the commit and the result arrives on the live topic.
 * 4. `ended`: the server was deleted, or moved onto a plugin's Connection, so
 *    the attempt has nothing left to follow.
 *
 * A server that signs in through the browser has a fifth state, `signing-in`,
 * which a `form` or a `following` attempt enters through `startSignIn` and
 * leaves through `cancelSignIn`, a refusal or a finished sign-in (which then
 * follows the server, as after a token). It runs these steps: the app that
 * can catch the browser's return starts a listener first (`listen`), then
 * `mcpServer.startSignIn` gives the authorization address, the app opens it,
 * and the return (or the pasted address) goes to `mcpServer.finishSignIn`.
 * An app that cannot catch the return (the web app, or the desktop app when
 * its listener is unavailable) uses the paste alone.
 *
 * What the rules are for:
 *
 * - The id comes from the dialog's own acknowledged create. The record is
 *   then read by that id and never taken from a write's reply, and no reply is
 *   cached. The read starts after the acknowledgement and cancels one that was
 *   already running, so a read that began before the commit cannot put back
 *   the state before it. A push that arrived before the attempt looked at the
 *   server is covered by that read.
 * - An attempt owns its replies. Closing a dialog detaches it from a write
 *   that still runs: the server stays if the create committed, and the reply
 *   never reaches a dialog opened afterwards.
 * - One submit per attempt. Whether an address already exists is the
 *   controller's decision, which holds across windows and clients.
 *
 * The module has no React in it. An app passes its cache's shapes in a
 * `McpUrlServerFlowCache` and subscribes its dialogs to `readState`.
 */
import {
  ConflictDetails,
  InvalidStateDetails,
  parseCallbackQuery,
  readApprovalHost,
  type McpServer,
  type McpServerSignInStart,
} from "@hercule/contract";
import { Schema } from "effect";
import { matchQuery, QueryObserver, type QueryClient, type QueryKey } from "@tanstack/query-core";
import type { HerculeClient } from "../client";
import { ApiError, readErrorMessage } from "../errors";
import { readAddForm, readFieldIssues, readTokenField, type FieldIssues } from "./add-by-url";
import type { ExistingServer, PluginOriginRefusal } from "./add-refusal";
import { readBaseAfterWrite, type McpListQuery } from "./reconcile";
import { buildPastedRedirectUri } from "../mcp-server-sign-in";
import {
  BROWSER_SIGN_IN_UNSUPPORTED,
  describePasteRefusal,
  describeSignInRefusal,
  type SignInRefusalReason,
} from "./sign-in-words";

/** What a refused or failed write leaves in the form. */
export type FlowProblem =
  /** The address is added already: `mcpServerId` is the server that holds it. */
  | {
      readonly kind: "exists";
      readonly mcpServerId: string;
      readonly existing: ExistingServer;
    }
  /** A plugin offers the address's server: it is made from the plugin's Connection. `message` is the controller's own sentence. */
  | {
      readonly kind: "plugin-origin";
      readonly refusal: PluginOriginRefusal;
      readonly message: string;
    }
  /** The controller refused a field. */
  | { readonly kind: "invalid"; readonly issues: FieldIssues }
  /** The write failed for another reason, such as a lost connection: `message` says why. */
  | { readonly kind: "failed"; readonly message: string }
  /** The controller says no sign-in through the browser works for this server, so only a pasted token does. */
  | { readonly kind: "sign-in-unsupported"; readonly message: string };

/**
 * What the check of the server found, as the dialog goes on from it. `server`
 * of the state is the record this was decided from.
 */
export type ServerOutcome =
  /** The record is being read. Nothing is known of the check yet. */
  | { readonly kind: "reading" }
  /** The record could not be read, so nothing is known of the check, which may well have succeeded. `message` is the reason. */
  | { readonly kind: "read-failed"; readonly message: string }
  /** The controller is asking the server for its tools. */
  | { readonly kind: "checking" }
  /** The server answered with its tools. `newServer` is true for a server this attempt created: the dialog then ends with the new server's footer. */
  | { readonly kind: "ready"; readonly toolCount: number; readonly newServer: boolean }
  /**
   * The server wants a token: the form is shown. `refusedAgain` is true when
   * the token this attempt just saved was refused, and `detail` is the
   * controller's own reason.
   */
  | {
      readonly kind: "needs-token";
      readonly detail: string | null;
      readonly refusedAgain: boolean;
    }
  /** The check ended with `unreachable` or `error`, and `detail` is the controller's reason. The user can check again or open the server. */
  | {
      readonly kind: "failed";
      readonly status: "unreachable" | "error";
      readonly detail: string | null;
    }
  /** The server is switched off, so it is not checked. `saved` says what this attempt saved, which is used when the server is switched on, or `null` when it saved nothing. */
  | { readonly kind: "off"; readonly saved: "token" | "sign-in" | null };

/** Why an attempt has nothing left to follow. */
export type EndReason =
  /** The server was deleted. */
  | "gone"
  /** The server is reached with a plugin's Connection now (Replace, or the token write was refused for it), so its sign-in is the Connection's. */
  | "moved"
  /** The dialog was closed. Only a state read after `close` has it. */
  | "closed";

/** What an attempt shows. */
export type UrlServerFlowState =
  | { readonly kind: "form"; readonly problem: FlowProblem | null }
  | { readonly kind: "writing"; readonly write: "create" | "token" }
  | {
      readonly kind: "signing-in";
      readonly mcpServerId: string;
      readonly step: SignInStep;
    }
  | {
      readonly kind: "following";
      readonly mcpServerId: string;
      /** The record `outcome` was decided from, or `null` while it has not been read. */
      readonly server: McpServer | null;
      readonly outcome: ServerOutcome;
      /** Why the last token write was refused or failed, shown with the token form. `null` when it was not. */
      readonly problem: FlowProblem | null;
    }
  | {
      readonly kind: "ended";
      readonly reason: EndReason;
      /** The server the attempt was about, when one is known. */
      readonly mcpServerId: string | null;
      /** Its name, when it is known. */
      readonly name: string | null;
      /** The controller's own words, when it ended the attempt by refusing a write. */
      readonly message: string | null;
    };

/**
 * Where the browser sign-in of an attempt is.
 *
 * - `starting`: the listener is starting and the controller is preparing the sign-in.
 * - `waiting`: the authorization address is out and the browser has not come back.
 * - `finishing`: the browser's answer is with the controller.
 * - `refused`: the sign-in ended without a sign-in. `message` says why and what to do.
 */
export type SignInStep =
  | { readonly kind: "starting" }
  | {
      readonly kind: "waiting";
      /** The address the browser opens. The app that cannot open it shows it as a link. */
      readonly authorizationUrl: string;
      /** The host that asks for the approval, shown before and while the browser is open. */
      readonly approvalHost: string;
      /** The time after which the controller no longer accepts the answer. */
      readonly expiresAt: string;
      /** `listener`: the app catches the browser's return itself. `paste`: the user pastes the address the browser ended on. */
      readonly returnBy: "listener" | "paste";
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

/** What the last read of the server's record found. */
export type RecordReading =
  | { readonly kind: "pending" }
  | { readonly kind: "failed"; readonly message: string }
  | { readonly kind: "gone" }
  | { readonly kind: "found"; readonly server: McpServer };

/** Where the record being followed came from: the attempt's own create, its token write, or its browser sign-in. */
export type FollowOrigin = "create" | "token" | "sign-in";

/**
 * Decides what an attempt shows of the record it follows, from the last
 * `reading` of it. A server that was deleted, or that is reached with a
 * plugin's Connection now, ends the attempt, even when the same id survived.
 * Any other record is read by its status:
 *
 * - switched off: `off`, whatever its status, because a switched-off server is
 *   not checked and its status is from before;
 * - `checking`, `ready`, `needs-sign-in`, `unreachable`, `error`: the outcome
 *   of that name.
 */
export const decideFollowing = ({
  reading,
  origin,
  createdHere = false,
  mcpServerId,
  problem,
}: {
  readonly reading: RecordReading;
  readonly origin: FollowOrigin;
  /** True when this attempt created the server (Add by URL), so a ready server ends with the new server's footer whatever its last write was. */
  readonly createdHere?: boolean;
  readonly mcpServerId: string;
  readonly problem: FlowProblem | null;
}): Extract<UrlServerFlowState, { kind: "following" | "ended" }> => {
  const following = (server: McpServer | null, outcome: ServerOutcome) =>
    ({ kind: "following", mcpServerId, server, outcome, problem }) as const;
  switch (reading.kind) {
    case "pending":
      return following(null, { kind: "reading" });
    case "failed":
      return following(null, { kind: "read-failed", message: reading.message });
    case "gone":
      return { kind: "ended", reason: "gone", mcpServerId, name: null, message: null };
    case "found": {
      const { server } = reading;
      if (server.source.kind !== "url") {
        return {
          kind: "ended",
          reason: "moved",
          mcpServerId,
          name: server.name,
          message: null,
        };
      }
      if (!server.enabled)
        return following(server, { kind: "off", saved: origin === "create" ? null : origin });
      switch (server.status) {
        case "checking":
          return following(server, { kind: "checking" });
        case "ready":
          return following(server, {
            kind: "ready",
            toolCount: server.tools.length,
            newServer: origin === "create" || createdHere,
          });
        case "needs-sign-in":
          return following(server, {
            kind: "needs-token",
            detail: server.statusDetail,
            refusedAgain: origin !== "create",
          });
        case "unreachable":
        case "error":
          return following(server, {
            kind: "failed",
            status: server.status,
            detail: server.statusDetail,
          });
      }
    }
  }
};

/** Returns what the dialog shows beside a server that answered: "ready · 1 tool" or "ready · 4 tools". */
export const describeReadyTools = (toolCount: number): string =>
  `ready · ${String(toolCount)} ${toolCount === 1 ? "tool" : "tools"}`;

/** Returns what the dialog says of a switched-off server, from what this attempt saved: the token or the sign-in is kept and used once the server is switched on. */
export const describeOffOutcome = (saved: "token" | "sign-in" | null): string =>
  saved === null
    ? "This server is switched off, so it is not checked."
    : `The ${saved} is saved. This server is switched off, so checking runs when it is switched on.`;

/** The footer a new server's dialog ends with, under "ready · N tools". */
export const NEW_SERVER_NOTE =
  "No project names it yet. A thread gets it from its project's list once a project names it, from the default list when it is named there, or when it is switched on in that thread's composer. Name it in the projects that should use it.";

/** How an app's cache holds what the attempts read. The module decides everything else. */
export interface McpUrlServerFlowCache {
  /** Returns the servers the cache holds now, or `undefined` while the list is not cached. */
  readServers(): readonly McpServer[] | undefined;
  /** Returns the query that reads the list of servers. After a write it is read again, so the list shows what the write did. */
  readCatalogue(): McpListQuery;
  /**
   * Returns the key and the read of one server's page. An attempt follows the
   * server with it, so the live topic's pushes read it again, and it is marked
   * stale when a closed attempt leaves a write behind.
   */
  readServerQuery(mcpServerId: string): {
    readonly queryKey: QueryKey;
    readonly queryFn: () => Promise<McpServer>;
  };
}

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

/** The attempts of Add by URL and of the token form. */
export interface McpUrlServerFlows {
  /** Starts an Add by URL attempt, for one opening of the dialog, and returns its id. */
  readonly openAdd: () => string;
  /**
   * Starts a token form for the server `mcpServerId`, named `name`, and
   * returns the attempt's id. Used for "Replace token…" and for the "Sign in…"
   * of a thread line and of the band.
   */
  readonly openToken: (mcpServerId: string, name: string) => string;
  /**
   * Sends `mcpServer.create` for the form's fields (see `readAddForm`).
   * Does nothing unless the attempt is a `form` of Add by URL whose fields
   * can be sent.
   */
  readonly submitAdd: (
    attemptId: string,
    fields: { readonly address: string; readonly typedName: string | null },
  ) => void;
  /**
   * Sends `mcpServer.setToken`. Does nothing unless the attempt is a token
   * `form`, or follows a server that needs a token, and the token follows the
   * contract's rule: a token it refuses is shown as the form's problem.
   */
  readonly submitToken: (attemptId: string, token: string) => void;
  /**
   * Starts the browser sign-in of the server the attempt is about. Does
   * nothing unless the attempt is a token `form`, follows a server, or shows a
   * refused sign-in (which this starts again). The attempt then shows
   * `signing-in` until it follows the signed-in server, ends, or is
   * cancelled.
   */
  readonly startSignIn: (attemptId: string) => Promise<void>;
  /**
   * Finishes the waiting sign-in with the address the user pasted, the whole
   * address the browser ended on or only its query. An address that is not a
   * redirect answer is shown as `pasteProblem` of the waiting step, and the
   * sign-in goes on waiting. Does nothing unless the sign-in is waiting.
   */
  readonly finishSignInByPaste: (attemptId: string, pasted: string) => Promise<void>;
  /** Opens the sign-in page again, for a waiting sign-in of an app that opens it. A failure is the waiting step's `openError`. */
  readonly openSignInPageAgain: (attemptId: string) => Promise<void>;
  /** Ends the sign-in that is starting, waiting or refused, and returns the attempt to where it was. */
  readonly cancelSignIn: (attemptId: string) => void;
  /** Reads the followed server again, after `read-failed`. */
  readonly retryRead: (attemptId: string) => void;
  /** Returns what the attempt shows. The object stays the same until it changes. */
  readonly readState: (attemptId: string) => UrlServerFlowState;
  /**
   * Closes the dialog: the attempt stops following and forgets its state. A
   * write that still runs is not undone, and the server it creates stays, so
   * the apps say so (see `describeClosing`).
   */
  readonly close: (attemptId: string) => void;
  /** Calls `listener` whenever the state of any attempt changes. Returns the function that stops it. */
  readonly subscribe: (listener: () => void) => () => void;
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

const CLOSED: UrlServerFlowState = {
  kind: "ended",
  reason: "closed",
  mcpServerId: null,
  name: null,
  message: null,
};

const FORM: UrlServerFlowState = { kind: "form", problem: null };

/** One dialog's attempt. */
interface Attempt {
  /** `add` starts without a server, and `token` with the one whose token it writes. */
  readonly kind: "add" | "token";
  state: UrlServerFlowState;
  mcpServerId: string | null;
  name: string | null;
  origin: FollowOrigin;
  reading: RecordReading;
  /** Stops following the server's record, or `null` while it does not. */
  stopFollowing: (() => void) | null;
  /** True once this attempt created the server. */
  createdHere: boolean;
  /** What the attempt showed when its browser sign-in started, which cancelling goes back to. */
  stateBeforeSignIn: UrlServerFlowState | null;
  /** The listener of the browser's return, or `null` while there is none. */
  listenerId: string | null;
  /** Counts the sign-ins the attempt started or ended, so the reply of an earlier one changes nothing. */
  signInRun: number;
}

/** Describes what closing the dialog does, from the attempt's state: a sentence for the dialog to show, or `null` when closing says nothing new. */
export const describeClosing = (state: UrlServerFlowState): string | null => {
  switch (state.kind) {
    case "writing":
      return state.write === "create"
        ? "The check creates the server. Closing now leaves it in the list, whatever the check finds."
        : "The token is being saved. Closing now does not undo it.";
    case "signing-in":
      return state.step.kind === "finishing"
        ? "The sign-in is being finished. Closing now does not undo it."
        : "Closing now ends the sign-in. The server stays in the list.";
    case "following":
      return state.outcome.kind === "ready" ? null : "The server stays in the list.";
    case "form":
    case "ended":
      return null;
  }
};

/**
 * Creates the attempts of Add by URL and of the token form over
 * `queryClient`, writing through `client` and reading the cache's shapes
 * through `cache`. An app uses one instance for its query client (see
 * `findOrCreateMcpUrlServerFlows`).
 */
export const createMcpUrlServerFlows = ({
  queryClient,
  client,
  cache,
  browserSignIn,
}: {
  readonly queryClient: QueryClient;
  readonly client: HerculeClient;
  readonly cache: McpUrlServerFlowCache;
  /** How the app catches the browser's return, or `undefined` when it cannot (the paste is used). */
  readonly browserSignIn?: BrowserSignInPort | undefined;
}): McpUrlServerFlows => {
  const attempts = new Map<string, Attempt>();
  const listeners = new Set<() => void>();
  let opened = 0;

  const commit = (attempt: Attempt, state: UrlServerFlowState): void => {
    attempt.state = state;
    for (const listener of listeners) listener();
  };

  const openAttempt = (
    attempt: Omit<
      Attempt,
      | "state"
      | "stopFollowing"
      | "reading"
      | "origin"
      | "createdHere"
      | "stateBeforeSignIn"
      | "listenerId"
      | "signInRun"
    >,
  ) => {
    opened += 1;
    const id = `url-server-attempt-${String(opened)}`;
    attempts.set(id, {
      ...attempt,
      state: FORM,
      origin: "create",
      reading: { kind: "pending" },
      stopFollowing: null,
      createdHere: false,
      stateBeforeSignIn: null,
      listenerId: null,
      signInRun: 0,
    });
    return id;
  };

  /** Returns the attempt if it is still the one the dialog `id` holds, so a reply of a closed or replaced attempt changes nothing. */
  const isCurrent = (id: string, attempt: Attempt): boolean => attempts.get(id) === attempt;

  /** Decides the attempt's state again from its last reading, while it follows a server. */
  const decideAgain = (attempt: Attempt): void => {
    const { state, mcpServerId } = attempt;
    if ((state.kind !== "following" && state.kind !== "signing-in") || mcpServerId === null) return;
    const decided = decideFollowing({
      reading: attempt.reading,
      origin: attempt.origin,
      createdHere: attempt.createdHere,
      mcpServerId,
      problem: state.kind === "following" ? state.problem : null,
    });
    if (decided.kind === "ended") {
      attempt.stopFollowing?.();
      attempt.stopFollowing = null;
      stopSignIn(attempt);
      commit(attempt, { ...decided, name: decided.name ?? attempt.name });
    } else if (state.kind === "following") {
      commit(attempt, decided);
    }
  };

  /** Ends the attempt's browser sign-in: the replies of the run that was going are ignored, and its listener is closed. */
  const stopSignIn = (attempt: Attempt): void => {
    attempt.signInRun += 1;
    const { listenerId } = attempt;
    attempt.listenerId = null;
    if (listenerId !== null) void browserSignIn?.cancel(listenerId).catch(() => {});
  };

  /**
   * Starts following the server `mcpServerId` after a write the controller
   * acknowledged. Reads that run now are cancelled first, so each one that
   * counts starts after the write. The cache listener starts before the
   * observer that starts the read, so no answer is missed, and the observer
   * keeps the query active, so a push on the live topic reads it again.
   */
  const follow = async (
    id: string,
    attempt: Attempt,
    mcpServerId: string,
    origin: FollowOrigin,
    problem: FlowProblem | null,
  ): Promise<void> => {
    attempt.stopFollowing?.();
    attempt.mcpServerId = mcpServerId;
    attempt.origin = origin;
    attempt.createdHere = attempt.createdHere || origin === "create";
    attempt.reading = { kind: "pending" };
    const { queryKey, queryFn } = cache.readServerQuery(mcpServerId);
    commit(attempt, {
      kind: "following",
      mcpServerId,
      server: null,
      outcome: { kind: "reading" },
      problem,
    });
    await queryClient.cancelQueries({ queryKey, exact: true });
    if (!isCurrent(id, attempt)) return;
    const read = (reading: RecordReading): void => {
      attempt.reading = reading;
      decideAgain(attempt);
    };
    const stopCache = queryClient.getQueryCache().subscribe((event) => {
      if (event.type !== "updated" || !matchQuery({ queryKey, exact: true }, event.query)) return;
      const { action } = event;
      if (action.type === "success" && action.manual !== true) {
        read({ kind: "found", server: event.query.state.data as McpServer });
      } else if (action.type === "error") {
        const error: unknown = event.query.state.error;
        read(
          error instanceof ApiError && error.code === "not_found"
            ? { kind: "gone" }
            : { kind: "failed", message: readErrorMessage(error) },
        );
      }
    });
    const stopObserver = new QueryObserver(queryClient, {
      queryKey,
      queryFn,
      retry: false,
      staleTime: 0,
      refetchOnMount: "always",
    }).subscribe(() => {});
    attempt.stopFollowing = () => {
      stopCache();
      stopObserver();
    };
  };

  /** Reads the list of servers again, so the list shows what a write did. Never fails. */
  const readCatalogueAgain = (): void => {
    void readBaseAfterWrite(queryClient, cache.readCatalogue()).then((watch) => {
      watch.stop();
    });
  };

  /** Finds what an `mcp-server-exists` refusal points at: the cache's list, else the record by its id. */
  const resolveExisting = async (
    id: string,
    attempt: Attempt,
    problem: Extract<FlowProblem, { kind: "exists" }>,
  ): Promise<void> => {
    const settle = (existing: ExistingServer): void => {
      const { state } = attempt;
      if (!isCurrent(id, attempt) || state.kind !== "form" || state.problem !== problem) return;
      commit(attempt, { kind: "form", problem: { ...problem, existing } });
    };
    const cached = cache.readServers()?.find((server) => server.id === problem.mcpServerId);
    if (cached !== undefined) {
      settle({ kind: "found", name: cached.name });
      return;
    }
    const { queryKey, queryFn } = cache.readServerQuery(problem.mcpServerId);
    try {
      const server = await queryClient.fetchQuery({
        queryKey,
        queryFn,
        retry: false,
        staleTime: 0,
      });
      settle({ kind: "found", name: server.name });
    } catch (error) {
      settle(
        error instanceof ApiError && error.code === "not_found"
          ? { kind: "gone" }
          : { kind: "unknown" },
      );
    }
  };

  const isConflictDetails = Schema.is(ConflictDetails);

  /** Turns a failure of a write into what the form shows. */
  const describeFailure = (error: unknown): FlowProblem => {
    if (
      error instanceof ApiError &&
      error.code === "conflict" &&
      isConflictDetails(error.details)
    ) {
      const { details } = error;
      return details.reason === "mcp-server-exists"
        ? { kind: "exists", mcpServerId: details.mcpServerId, existing: { kind: "reading" } }
        : {
            kind: "plugin-origin",
            refusal: { contributionId: details.contributionId, connectionId: details.connectionId },
            message: error.message,
          };
    }
    const issues = readFieldIssues(error);
    return issues === undefined
      ? { kind: "failed", message: readErrorMessage(error) }
      : { kind: "invalid", issues };
  };

  /** Puts `problem` in the form the attempt shows now, `form` or `following`. */
  const showProblem = (
    attempt: Attempt,
    before: UrlServerFlowState,
    problem: FlowProblem,
  ): void => {
    commit(
      attempt,
      before.kind === "following" ? { ...before, problem } : { kind: "form", problem },
    );
  };

  const submitToken = (id: string, token: string): void => {
    const attempt = attempts.get(id);
    if (attempt === undefined || attempt.mcpServerId === null) return;
    const before = attempt.state;
    const ready =
      before.kind === "form" ||
      (before.kind === "following" && before.outcome.kind === "needs-token");
    if (!ready) return;
    const { canSubmit, issue } = readTokenField(token);
    if (!canSubmit) {
      showProblem(attempt, before, {
        kind: "invalid",
        issues: { address: null, name: null, token: issue, other: null },
      });
      return;
    }
    const mcpServerId = attempt.mcpServerId;
    commit(attempt, { kind: "writing", write: "token" });
    void (async () => {
      let failure: unknown;
      let saved = false;
      try {
        await client.mcpServer.setToken({ params: { id: mcpServerId }, payload: { token } });
        saved = true;
      } catch (error) {
        failure = error;
      }
      // Whoever shows the server reads it again, whether or not this dialog is still open.
      const { queryKey } = cache.readServerQuery(mcpServerId);
      void queryClient.invalidateQueries({ queryKey, exact: true });
      readCatalogueAgain();
      if (!isCurrent(id, attempt)) return;
      if (saved) {
        await follow(id, attempt, mcpServerId, "token", null);
      } else if (failure instanceof ApiError && failure.code === "not_found") {
        commit(attempt, {
          kind: "ended",
          reason: "gone",
          mcpServerId,
          name: attempt.name,
          message: null,
        });
      } else if (failure instanceof ApiError && failure.code === "invalid_state") {
        // The record is reached with a Connection now, whose sign-in this form cannot write.
        commit(attempt, {
          kind: "ended",
          reason: "moved",
          mcpServerId,
          name: attempt.name,
          message: failure.message,
        });
      } else {
        // Back to the form the user wrote in, decided again from what the server did meanwhile.
        showProblem(attempt, before, describeFailure(failure));
        decideAgain(attempt);
      }
    })();
  };

  /** Returns the attempt to what it showed before its sign-in, with `problem` for the token form it comes back to. */
  const leaveSignIn = (attempt: Attempt, problem: FlowProblem | null): void => {
    const before = attempt.stateBeforeSignIn;
    attempt.stateBeforeSignIn = null;
    if (before?.kind === "following") {
      commit(attempt, { ...before, problem });
      decideAgain(attempt);
    } else {
      commit(attempt, { kind: "form", problem });
    }
  };

  /** Turns the failure of `startSignIn` or `finishSignIn` into what the attempt does next. */
  const readSignInFailure = (error: unknown): SignInFailure => {
    if (!(error instanceof ApiError)) return refused("failed", readErrorMessage(error));
    if (error.code === "not_found") return { kind: "ended", reason: "gone", message: null };
    if (error.code === "validation") return { kind: "invalid", message: readErrorMessage(error) };
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

  /** Shows what a failed sign-in step leads to. The caller has checked that its run is the current one. */
  const showSignInFailure = (attempt: Attempt, failure: SignInFailure): void => {
    const { mcpServerId } = attempt;
    if (mcpServerId === null) return;
    switch (failure.kind) {
      case "ended":
        stopSignIn(attempt);
        attempt.stopFollowing?.();
        attempt.stopFollowing = null;
        commit(attempt, {
          kind: "ended",
          reason: failure.reason,
          mcpServerId,
          name: attempt.name,
          message: failure.message,
        });
        return;
      case "unsupported":
        stopSignIn(attempt);
        leaveSignIn(attempt, { kind: "sign-in-unsupported", message: BROWSER_SIGN_IN_UNSUPPORTED });
        return;
      case "refused":
        stopSignIn(attempt);
        commit(attempt, {
          kind: "signing-in",
          mcpServerId,
          step: { kind: "refused", reason: failure.reason, message: failure.message },
        });
        return;
      case "invalid":
        // Only a pasted address is judged by its text, and `finishByAddress` handles that. Any other
        // validation failure is a request the controller refused.
        showSignInFailure(attempt, refused("failed", failure.message));
    }
  };

  /**
   * Sends what the browser came back with to `mcpServer.finishSignIn` and
   * follows the signed-in server. `back` is the waiting step to return to
   * when the controller finds the pasted text is not a redirect answer, or
   * `null` when the text came from the listener.
   */
  const finishSignIn = async (
    id: string,
    attempt: Attempt,
    run: number,
    callbackQuery: string,
    back: Extract<SignInStep, { kind: "waiting" }> | null,
  ): Promise<void> => {
    const { mcpServerId } = attempt;
    if (mcpServerId === null) return;
    commit(attempt, { kind: "signing-in", mcpServerId, step: { kind: "finishing" } });
    let failure: unknown;
    let finished = false;
    try {
      await client.mcpServer.finishSignIn({
        params: { id: mcpServerId },
        payload: { callbackQuery },
      });
      finished = true;
    } catch (error) {
      failure = error;
    }
    if (finished) {
      // Whoever shows the server reads it again, whether or not this dialog is still open.
      void queryClient.invalidateQueries({
        queryKey: cache.readServerQuery(mcpServerId).queryKey,
        exact: true,
      });
      readCatalogueAgain();
    }
    if (!isCurrent(id, attempt) || attempt.signInRun !== run) return;
    if (finished) {
      stopSignIn(attempt);
      attempt.stateBeforeSignIn = null;
      await follow(id, attempt, mcpServerId, "sign-in", null);
      return;
    }
    const result = readSignInFailure(failure);
    if (result.kind === "invalid" && back !== null) {
      commit(attempt, {
        kind: "signing-in",
        mcpServerId,
        step: { ...back, returnBy: "paste", pasteProblem: result.message },
      });
      return;
    }
    showSignInFailure(attempt, result);
  };

  const startSignIn = async (id: string): Promise<void> => {
    const attempt = attempts.get(id);
    if (attempt === undefined || attempt.mcpServerId === null) return;
    const { state, mcpServerId } = attempt;
    const refusedBefore = state.kind === "signing-in" && state.step.kind === "refused";
    if (state.kind !== "form" && state.kind !== "following" && !refusedBefore) return;
    if (state.kind !== "signing-in") attempt.stateBeforeSignIn = state;
    stopSignIn(attempt);
    const run = attempt.signInRun;
    const stillWanted = (): boolean => isCurrent(id, attempt) && attempt.signInRun === run;
    commit(attempt, { kind: "signing-in", mcpServerId, step: { kind: "starting" } });

    let listenerId: string | null = null;
    let started: McpServerSignInStart;
    try {
      const listening = browserSignIn === undefined ? undefined : await browserSignIn.listen();
      let redirectUri: string;
      if (listening?.kind === "listening") {
        if (!stillWanted()) {
          void browserSignIn?.cancel(listening.listenerId).catch(() => {});
          return;
        }
        listenerId = listening.listenerId;
        attempt.listenerId = listenerId;
        redirectUri = listening.redirectUri;
      } else {
        if (!stillWanted()) return;
        redirectUri = buildPastedRedirectUri();
      }
      started = await client.mcpServer.startSignIn({
        params: { id: mcpServerId },
        payload: { redirectUri },
      });
    } catch (error) {
      if (stillWanted()) showSignInFailure(attempt, readSignInFailure(error));
      return;
    }
    if (!stillWanted()) return;
    const waiting: Extract<SignInStep, { kind: "waiting" }> = {
      kind: "waiting",
      authorizationUrl: started.authorizationUrl,
      approvalHost: readApprovalHost(started.authorizationUrl),
      expiresAt: started.expiresAt,
      returnBy: listenerId === null ? "paste" : "listener",
      openError: null,
      pasteProblem: null,
    };
    // The host is on screen before the browser opens.
    commit(attempt, { kind: "signing-in", mcpServerId, step: waiting });
    if (browserSignIn !== undefined) void openSignInPage(id, attempt, run);
    if (listenerId !== null)
      void awaitReturn(id, attempt, run, listenerId, started.authorizationUrl);
  };

  /** Waits for the browser to come back to the listener, then finishes the sign-in or shows why it did not. Runs beside the waiting step, so a pasted address or a cancel can take over. */
  const awaitReturn = async (
    id: string,
    attempt: Attempt,
    run: number,
    listenerId: string,
    authorizationUrl: string,
  ): Promise<void> => {
    if (browserSignIn === undefined) return;
    const outcome = await browserSignIn
      .wait(listenerId, authorizationUrl)
      .catch((): { kind: "cancelled" } => ({ kind: "cancelled" }));
    // A paste, a cancel, a close or a newer sign-in took this listener over.
    if (!isCurrent(id, attempt) || attempt.signInRun !== run || attempt.listenerId !== listenerId) {
      return;
    }
    attempt.listenerId = null;
    switch (outcome.kind) {
      case "received":
        await finishSignIn(id, attempt, run, outcome.callbackQuery, null);
        return;
      case "timed-out":
        showSignInFailure(attempt, refused("timed-out", ""));
        return;
      case "cancelled":
        showSignInFailure(
          attempt,
          refused("failed", "The app stopped waiting for the browser. Start again."),
        );
    }
  };

  /** Opens the sign-in page of the waiting step, and shows why it could not be opened. */
  const openSignInPage = async (id: string, attempt: Attempt, run: number): Promise<void> => {
    const { state } = attempt;
    if (
      browserSignIn === undefined ||
      state.kind !== "signing-in" ||
      state.step.kind !== "waiting"
    ) {
      return;
    }
    const waiting = state.step;
    let openError: string | null = null;
    try {
      await browserSignIn.open(waiting.authorizationUrl);
    } catch (error) {
      openError = readErrorMessage(error);
    }
    const { state: now } = attempt;
    if (!isCurrent(id, attempt) || attempt.signInRun !== run) return;
    if (now.kind !== "signing-in" || now.step.kind !== "waiting") return;
    if (now.step.openError === openError) return;
    commit(attempt, {
      kind: "signing-in",
      mcpServerId: now.mcpServerId,
      step: { ...now.step, openError },
    });
  };

  return {
    openAdd: () => openAttempt({ kind: "add", mcpServerId: null, name: null }),
    openToken: (mcpServerId, name) => openAttempt({ kind: "token", mcpServerId, name }),
    submitAdd: (id, fields) => {
      const attempt = attempts.get(id);
      if (attempt === undefined || attempt.kind !== "add" || attempt.state.kind !== "form") return;
      const form = readAddForm(fields);
      if (!form.canSubmit) return;
      commit(attempt, { kind: "writing", write: "create" });
      void (async () => {
        let created: McpServer | undefined;
        let failure: unknown;
        try {
          created = await client.mcpServer.create({
            payload: {
              source: {
                kind: "url",
                url: form.createAddress,
                ...(form.createName === undefined ? {} : { name: form.createName }),
              },
            },
          });
        } catch (error) {
          failure = error;
        }
        // The server exists whether or not this dialog is still open.
        if (created !== undefined) readCatalogueAgain();
        if (!isCurrent(id, attempt)) return;
        if (created !== undefined) {
          attempt.name = created.name;
          await follow(id, attempt, created.id, "create", null);
          return;
        }
        const problem = describeFailure(failure);
        commit(attempt, { kind: "form", problem });
        if (problem.kind === "exists") void resolveExisting(id, attempt, problem);
      })();
    },
    submitToken,
    startSignIn,
    finishSignInByPaste: async (id, pasted) => {
      const attempt = attempts.get(id);
      if (attempt === undefined) return;
      const { state } = attempt;
      if (state.kind !== "signing-in" || state.step.kind !== "waiting") return;
      const { step, mcpServerId } = state;
      const parsed = parseCallbackQuery(pasted);
      if (parsed._tag === "Refused") {
        commit(attempt, {
          kind: "signing-in",
          mcpServerId,
          step: { ...step, pasteProblem: describePasteRefusal(parsed.reason) },
        });
        return;
      }
      // The pasted address replaces the listener: closing it makes the wait end, and the wait is ignored.
      const { listenerId } = attempt;
      attempt.listenerId = null;
      if (listenerId !== null) void browserSignIn?.cancel(listenerId).catch(() => {});
      await finishSignIn(id, attempt, attempt.signInRun, pasted.trim(), step);
    },
    openSignInPageAgain: async (id) => {
      const attempt = attempts.get(id);
      if (attempt !== undefined) await openSignInPage(id, attempt, attempt.signInRun);
    },
    cancelSignIn: (id) => {
      const attempt = attempts.get(id);
      if (attempt === undefined || attempt.state.kind !== "signing-in") return;
      if (attempt.state.step.kind === "finishing") return;
      stopSignIn(attempt);
      leaveSignIn(attempt, null);
    },
    retryRead: (id) => {
      const attempt = attempts.get(id);
      const { state } = attempt ?? {};
      if (attempt === undefined || attempt.mcpServerId === null) return;
      if (state?.kind !== "following" || state.outcome.kind !== "read-failed") return;
      attempt.reading = { kind: "pending" };
      commit(attempt, { ...state, outcome: { kind: "reading" } });
      void queryClient.invalidateQueries({
        queryKey: cache.readServerQuery(attempt.mcpServerId).queryKey,
        exact: true,
      });
    },
    readState: (id) => attempts.get(id)?.state ?? CLOSED,
    close: (id) => {
      const attempt = attempts.get(id);
      if (attempt === undefined) return;
      attempt.stopFollowing?.();
      stopSignIn(attempt);
      attempts.delete(id);
      for (const listener of listeners) listener();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
};

const sharedFlows = new WeakMap<QueryClient, McpUrlServerFlows>();

/**
 * Returns the attempts of `queryClient`, creating them with `options` the
 * first time. There is one instance for each query client, so a dialog that
 * closes and opens again never meets the reply of the attempt before it.
 */
export const findOrCreateMcpUrlServerFlows = (options: {
  readonly queryClient: QueryClient;
  readonly client: HerculeClient;
  readonly cache: McpUrlServerFlowCache;
  readonly browserSignIn?: BrowserSignInPort | undefined;
}): McpUrlServerFlows => {
  const found = sharedFlows.get(options.queryClient);
  if (found !== undefined) return found;
  const created = createMcpUrlServerFlows(options);
  sharedFlows.set(options.queryClient, created);
  return created;
};
