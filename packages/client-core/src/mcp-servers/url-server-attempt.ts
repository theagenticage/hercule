/**
 * The attempt of one dialog that writes a server added by URL: Add by URL, or
 * the token form (the page's "Replace token…", and the "Sign in…" of a thread
 * line and of the band). The dialog opens its attempt when it mounts
 * (`openUrlServerAttempt`), draws `read()`, calls the attempt's methods, and
 * closes it when it goes. Nothing is shared between dialogs.
 *
 * An attempt is always in one phase, and what a phase holds lives in the
 * phase:
 *
 * 1. `form`: the user fills the fields. Nothing was sent. An Add form that
 *    shows the "added before" refusal reads that one server by its id, so its
 *    button leads to the server or says it is gone.
 * 2. `writing`: the one write of the attempt runs (`mcpServer.create` or
 *    `mcpServer.setToken`). A second submit meanwhile does nothing.
 * 3. `following`: the controller acknowledged the write. The attempt reads the
 *    server by its id and follows it, because the controller checks the server
 *    after the commit and the result arrives on the live topic. "Check now"
 *    belongs to this phase.
 * 4. `signing-in`: the sign-in through the browser. It holds the listener of
 *    the browser's return and the phase to go back to.
 * 5. `ended`: the server was deleted, or moved onto a plugin's Connection, or
 *    the dialog was closed. Nothing is left to follow.
 *
 * Leaving a phase releases what it holds, in one place (`enter`): the
 * listener of the browser's return, the check timer, the reads of the server.
 * A reply that comes back to a phase that was left changes nothing, because
 * every reply checks that its phase is still the current one. A write the
 * controller was already sent is the exception to "changes nothing": the
 * server it changed stays changed, so its caches are read again whoever is
 * still looking.
 *
 * The identity of an attempt is the id of its server (or "a new server" for
 * Add), never the server's name, which can change while the dialog is open.
 *
 * The module has no React in it. An app passes how its cache holds the
 * servers in `McpServerQueries`, and its way to catch the browser's return in
 * a `BrowserSignInPort`.
 */
import { ConflictDetails, type McpServer } from "@hercule/contract";
import { Schema } from "effect";
import { matchQuery, QueryObserver, type QueryClient } from "@tanstack/query-core";
import type { HerculeClient } from "../client";
import { ApiError, readErrorMessage } from "../errors";
import { readAddForm, readFieldIssues, readTokenField, type FieldIssues } from "./add-by-url";
import type { ExistingServer, PluginOriginRefusal } from "./add-refusal";
import {
  createBrowserSignIn,
  type BrowserSignInPort,
  type SignInUnsupportedProblem,
  type SigningInPhase,
  type SigningInState,
} from "./browser-sign-in";
import { readBaseAfterWrite, type McpServerQueries } from "./reconcile";

/** What a refused or failed write leaves in the form. */
export type AttemptProblem =
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
  | SignInUnsupportedProblem;

/** How a dialog wrote the server's sign-in: the pasted token, or the browser sign-in. */
export type WrittenMethod = "token" | "sign-in";

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
   * The server wants a token: the form is shown. `refusedWrite` is the way
   * this attempt signed in that the check then refused, or `null` when the
   * attempt wrote nothing (a new server that asks for sign-in). `detail` is
   * the controller's own reason.
   */
  | {
      readonly kind: "needs-token";
      readonly detail: string | null;
      readonly refusedWrite: WrittenMethod | null;
    }
  /** The check ended with `unreachable` or `error`, and `detail` is the controller's reason. The user can check again or open the server. */
  | {
      readonly kind: "failed";
      readonly status: "unreachable" | "error";
      readonly detail: string | null;
    }
  /** The server is switched off, so it is not checked. `saved` says what this attempt saved, which is used when the server is switched on, or `null` when it saved nothing. */
  | { readonly kind: "off"; readonly saved: WrittenMethod | null };

/** Why an attempt has nothing left to follow. */
export type EndReason =
  /** The server was deleted. */
  | "gone"
  /** The server is reached with a plugin's Connection now (Replace, or the token write was refused for it), so its sign-in is the Connection's. */
  | "moved"
  /** The dialog was closed. */
  | "closed";

/** What "Check now" shows. */
export interface CheckNowState {
  /** True from the press until the followed server's record changes, which is the check's answer. A second press does nothing meanwhile. */
  readonly busy: boolean;
  /** Why the controller refused the check, or `null`. */
  readonly error: string | null;
}

const IDLE_CHECK_NOW: CheckNowState = { busy: false, error: null };

/**
 * How long "Check now" waits for the record to change. A check that finds
 * what the last one found changes nothing the record shows, and the
 * controller announces nothing for it, so the wait must end by itself.
 */
export const CHECK_ANSWER_WAIT_MILLIS = 30_000;

/** What an attempt shows. `read()` returns the same object until something changes. */
export type UrlServerAttemptState =
  | { readonly kind: "form"; readonly problem: AttemptProblem | null }
  | { readonly kind: "writing"; readonly write: "create" | "token" }
  | SigningInState
  | {
      readonly kind: "following";
      readonly mcpServerId: string;
      /** The record `outcome` was decided from, or `null` while it has not been read. */
      readonly server: McpServer | null;
      readonly outcome: ServerOutcome;
      /** Why the last token write was refused or failed, shown with the token form. `null` when it was not. */
      readonly problem: AttemptProblem | null;
      readonly check: CheckNowState;
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
 *
 * `createdHere` is true when this attempt created the server (Add by URL), so
 * a ready server ends with the new server's footer whatever its last write
 * was. The result has no `check`: the caller adds it to a `following` state.
 */
export const decideFollowing = ({
  reading,
  origin,
  createdHere,
  mcpServerId,
  problem,
}: {
  readonly reading: RecordReading;
  readonly origin: FollowOrigin;
  readonly createdHere: boolean;
  readonly mcpServerId: string;
  readonly problem: AttemptProblem | null;
}):
  | Omit<Extract<UrlServerAttemptState, { kind: "following" }>, "check">
  | { readonly kind: "ended"; readonly reason: "gone" | "moved"; readonly name: string | null } => {
  const following = (server: McpServer | null, outcome: ServerOutcome) =>
    ({ kind: "following", mcpServerId, server, outcome, problem }) as const;
  switch (reading.kind) {
    case "pending":
      return following(null, { kind: "reading" });
    case "failed":
      return following(null, { kind: "read-failed", message: reading.message });
    case "gone":
      return { kind: "ended", reason: "gone", name: null };
    case "found": {
      const { server } = reading;
      if (server.source.kind !== "url") {
        return { kind: "ended", reason: "moved", name: server.name };
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
            refusedWrite: origin === "create" ? null : origin,
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

/** The fields of the Add by URL form. */
export interface AddFields {
  readonly address: string;
  /** What the user typed in the Name field, or `null` while they never touched it. */
  readonly typedName: string | null;
}

/** What a dialog opens its attempt for. */
export type AttemptTarget =
  /** Add by URL: the server does not exist yet. */
  | { readonly kind: "add" }
  /** The token form of the server `mcpServerId`. `name` is used in words only, until the attempt has read the record. */
  | { readonly kind: "token"; readonly mcpServerId: string; readonly name: string };

/** One dialog's attempt, as the dialog drives it. */
export interface UrlServerAttempt {
  /** Returns what the attempt shows. The object stays the same until it changes. */
  readonly read: () => UrlServerAttemptState;
  /** Calls `listener` whenever what the attempt shows changes. Returns the function that stops it. */
  readonly subscribe: (listener: () => void) => () => void;
  /**
   * Tells the attempt what the Add form's fields hold now. A refusal belongs
   * to the fields that were sent, so it goes away once they differ.
   */
  readonly changeFields: (fields: AddFields) => void;
  /**
   * Sends `mcpServer.create` for the fields (see `readAddForm`). Does nothing
   * unless this is an Add attempt that shows its form and the fields can be
   * sent.
   */
  readonly submitAdd: (fields: AddFields) => void;
  /**
   * Sends `mcpServer.setToken`. Does nothing unless the attempt shows a token
   * form, or follows a server that needs a token. A token that breaks the
   * contract's rule is not sent and shows as the form's problem.
   */
  readonly submitToken: (token: string) => void;
  /**
   * Starts the browser sign-in of the server the attempt is about. Does
   * nothing unless the attempt shows a token form, follows a server, or shows
   * a refused sign-in (which this starts again). The attempt then shows
   * `signing-in` until it follows the signed-in server, ends, or is cancelled.
   */
  readonly startSignIn: () => Promise<void>;
  /**
   * Finishes the waiting sign-in with the address the user pasted, the whole
   * address the browser ended on or only its query. An address that is not a
   * redirect answer is shown as `pasteProblem` of the waiting step, and the
   * sign-in goes on waiting. Does nothing unless the sign-in is waiting.
   */
  readonly finishSignInByPaste: (pasted: string) => Promise<void>;
  /**
   * Records that the user pressed the button that opens the sign-in page, and
   * opens it when the app has a browser port. The browser never opens by
   * itself. An app without a port draws the button as a link that opens the
   * page itself, and calls this so the step reads "Open again" from then on.
   * A failure to open is the waiting step's `openError`. Does nothing unless
   * the sign-in is waiting.
   */
  readonly openSignInPage: () => Promise<void>;
  /** Ends the sign-in that is starting, waiting or refused, and returns the attempt to what it showed before. */
  readonly cancelSignIn: () => void;
  /** Reads the followed server again, after `read-failed`. */
  readonly retryRead: () => void;
  /**
   * Asks the controller to check the followed server again, then reads the
   * server and the list again. The controller acknowledges the request and
   * checks later, leaving the record as it was until the check has an answer,
   * so the state's `check` is `busy` until the record changes (or
   * `CHECK_ANSWER_WAIT_MILLIS` pass). Resolves to the controller's reason when
   * it refused the check, or `null`. Does nothing, and resolves to `null`,
   * when the attempt follows no server or a check is pending.
   */
  readonly checkNow: () => Promise<string | null>;
  /**
   * Ends the attempt: it releases everything its phase holds, and what it
   * shows is `ended` with the reason `closed`. A write that still runs is not
   * undone, and the server it creates stays. Closing twice is fine.
   */
  readonly close: () => void;
}

const FIRST_FORM: AttemptStateWithKind<"form"> = { kind: "form", problem: null };

/** The attempt a dialog holds until its own is open: it shows the empty form and does nothing. */
const UNOPENED_ATTEMPT: UrlServerAttempt = {
  read: () => FIRST_FORM,
  subscribe: () => () => {},
  changeFields: () => {},
  submitAdd: () => {},
  submitToken: () => {},
  startSignIn: () => Promise.resolve(),
  finishSignInByPaste: () => Promise.resolve(),
  openSignInPage: () => Promise.resolve(),
  cancelSignIn: () => {},
  retryRead: () => {},
  checkNow: () => Promise.resolve(null),
  close: () => {},
};

/**
 * Where a dialog reads its attempt from. A dialog opens its attempt in a
 * layout effect, after its first render, and an effect may not set React state,
 * so the attempt lives in this small store that the dialog subscribes to.
 */
export interface AttemptSlot {
  /** Returns the attempt the slot holds: an inert one that shows the empty form until `hold` is called. */
  readonly read: () => UrlServerAttempt;
  readonly subscribe: (listener: () => void) => () => void;
  /** Puts `attempt` in the slot and tells the subscribers. */
  readonly hold: (attempt: UrlServerAttempt) => void;
}

/** Returns an empty slot, for one mounted dialog. */
export const createAttemptSlot = (): AttemptSlot => {
  let held = UNOPENED_ATTEMPT;
  const listeners = new Set<() => void>();
  return {
    read: () => held,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    hold: (attempt) => {
      held = attempt;
      for (const listener of listeners) listener();
    },
  };
};

const isConflictDetails = Schema.is(ConflictDetails);

/** The phase a sign-in or a token write returns to when it does not lead on. */
type Back =
  | { readonly kind: "form" }
  | {
      readonly kind: "following";
      readonly origin: FollowOrigin;
      readonly server: McpServer | null;
      readonly outcome: ServerOutcome;
    };

type AttemptStateWithKind<K extends UrlServerAttemptState["kind"]> = Extract<
  UrlServerAttemptState,
  { kind: K }
>;

interface FormPhase {
  readonly kind: "form";
  state: AttemptStateWithKind<"form">;
  /** The fields the refusal in `state` was made for. `null` for a token form, which has none. */
  readonly sent: AddFields | null;
  release: () => void;
}

interface WritingPhase {
  readonly kind: "writing";
  state: AttemptStateWithKind<"writing">;
  /** Where a refused or failed token write returns to. */
  readonly back: Back;
  release: () => void;
}

/** A "Check now" press that the record has not answered yet. */
interface PendingCheck {
  /** True once the controller acknowledged the press. The record answers it only from then on. */
  acknowledged: boolean;
  /** What the followed record held at the press, or `null` when none was read. */
  readonly recordAtPress: { readonly updatedAt: string; readonly checkedAt: string | null } | null;
  /** Ends the wait when the record never changes, or `null` before the acknowledgement. */
  timer: ReturnType<typeof setTimeout> | null;
}

interface FollowingPhase {
  readonly kind: "following";
  state: AttemptStateWithKind<"following">;
  readonly origin: FollowOrigin;
  problem: AttemptProblem | null;
  reading: RecordReading;
  check: CheckNowState;
  pendingCheck: PendingCheck | null;
  release: () => void;
}

interface EndedPhase {
  readonly kind: "ended";
  state: AttemptStateWithKind<"ended">;
  release: () => void;
}

type Phase = FormPhase | WritingPhase | SigningInPhase | FollowingPhase | EndedPhase;

const noRelease = (): void => {};

/**
 * Opens the attempt of a dialog for `target`, writing through `client`,
 * reading the cache's shapes through `queries`, and catching the browser's
 * return through `browserSignIn` (or, when it is `undefined`, with the paste).
 */
export const openUrlServerAttempt = (
  {
    queryClient,
    client,
    queries,
    browserSignIn,
  }: {
    readonly queryClient: QueryClient;
    readonly client: HerculeClient;
    readonly queries: McpServerQueries;
    /** How the app catches the browser's return, or `undefined` when it cannot (the paste is used). */
    readonly browserSignIn?: BrowserSignInPort | undefined;
  },
  target: AttemptTarget,
): UrlServerAttempt => {
  const listeners = new Set<() => void>();
  /** The server the attempt is about: given for a token form, known after the acknowledged create for Add. */
  let mcpServerId: string | null = target.kind === "token" ? target.mcpServerId : null;
  let name: string | null = target.kind === "token" ? target.name : null;
  /** True once this attempt created the server. */
  let createdHere = false;
  let phase: Phase = {
    kind: "form",
    state: FIRST_FORM,
    sent: null,
    release: noRelease,
  };

  const publish = (): void => {
    for (const listener of listeners) listener();
  };

  /**
   * Makes `next` the phase, after releasing what the phase that is left holds.
   * `attach` takes what `next` holds (watchers, observers) and returns the
   * function that releases it. It runs before the phase is published: a
   * subscriber that closes the attempt from that notification then releases
   * `next` like any other phase, and no observer outlives the attempt.
   */
  const enter = (next: Phase, attach?: () => () => void): void => {
    const left = phase;
    phase = next;
    left.release();
    if (attach !== undefined) next.release = attach();
    publish();
  };

  /** Shows `state` for the phase `owner`, unless the attempt left it meanwhile: a reply for a phase that is gone changes nothing. */
  const show = <P extends Phase>(owner: P, state: P["state"]): void => {
    if (phase !== owner) return;
    (owner as { state: UrlServerAttemptState }).state = state;
    publish();
  };

  const end = (reason: "gone" | "moved", message: string | null, recordName: string | null) => {
    enter({
      kind: "ended",
      state: {
        kind: "ended",
        reason,
        mcpServerId,
        name: recordName ?? name,
        message,
      },
      release: noRelease,
    });
  };

  /**
   * Reads the server `id` and calls `onReading` with what each read found,
   * until the returned function stops it. Reads that run now are cancelled
   * first, so each one that counts starts after the call. The cache listener
   * starts before the observer that starts the read, so no answer is missed,
   * and the observer keeps the query active, so a push on the live topic reads
   * it again.
   */
  const followRecord = (id: string, onReading: (reading: RecordReading) => void): (() => void) => {
    let stopped = false;
    let stopWatching = noRelease;
    const serverQuery = queries.buildServerQuery(id);
    const { queryKey } = serverQuery;
    void (async () => {
      await queryClient.cancelQueries({ queryKey, exact: true });
      if (stopped) return;
      const stopCache = queryClient.getQueryCache().subscribe((event) => {
        if (event.type !== "updated" || !matchQuery({ queryKey, exact: true }, event.query)) return;
        const { action } = event;
        if (action.type === "success" && action.manual !== true) {
          onReading({ kind: "found", server: event.query.state.data as McpServer });
        } else if (action.type === "error") {
          const error: unknown = event.query.state.error;
          onReading(
            error instanceof ApiError && error.code === "not_found"
              ? { kind: "gone" }
              : { kind: "failed", message: readErrorMessage(error) },
          );
        }
      });
      const stopObserver = new QueryObserver(queryClient, {
        ...serverQuery,
        retry: false,
        staleTime: 0,
        refetchOnMount: "always",
      }).subscribe(() => {});
      stopWatching = () => {
        stopCache();
        stopObserver();
      };
    })();
    return () => {
      stopped = true;
      stopWatching();
    };
  };

  /**
   * Watches the list of servers while `owner` waits for the user or the
   * browser, so a dialog never keeps pointing at what is gone: a server that
   * was deleted, or that is reached with a plugin's Connection now, ends the
   * attempt with `gone` or `moved`. A sign-in that is being finished decides
   * for itself. Returns the function that stops watching.
   */
  const watchCatalogue = (owner: FormPhase | SigningInPhase, id: string): (() => void) => {
    const { queryKey } = queries.readCatalogue();
    return queryClient.getQueryCache().subscribe((event) => {
      if (
        event.type !== "updated" ||
        event.action.type !== "success" ||
        !matchQuery({ queryKey, exact: true }, event.query)
      ) {
        return;
      }
      endIfCatalogueDisagrees(owner, id);
    });
  };

  /**
   * Ends the attempt with `gone` or `moved` when the servers the cache holds
   * now show that the server `id` was deleted or is reached with a plugin's
   * Connection. Does nothing while `owner` is not the phase, while a sign-in
   * is being finished, and while the list is not read yet: an unread list
   * decides nothing, and its first read does.
   */
  const endIfCatalogueDisagrees = (owner: FormPhase | SigningInPhase, id: string): void => {
    if (phase !== owner || (owner.kind === "signing-in" && owner.state.step.kind === "finishing")) {
      return;
    }
    const servers = queries.readServers();
    if (servers === undefined) return;
    const record = servers.find((server) => server.id === id);
    if (record !== undefined && record.source.kind === "url") return;
    end(record === undefined ? "gone" : "moved", null, record?.name ?? null);
  };

  /** Reads the list of servers again, so the list shows what a write did. Never fails. */
  const readCatalogueAgain = (): void => {
    void readBaseAfterWrite(queryClient, queries.readCatalogue()).then((watch) => {
      watch.stop();
    });
  };

  /** Marks the server's page stale, so whoever shows it reads it again. */
  const invalidateServerPage = (id: string): void => {
    void queryClient.invalidateQueries({
      queryKey: queries.buildServerQuery(id).queryKey,
      exact: true,
    });
  };

  // ---- form

  /** Shows the form, with `problem` for the fields `sent` (Add) when the last write was refused. */
  const enterForm = (problem: AttemptProblem | null, sent: AddFields | null = null): void => {
    const owner: FormPhase = {
      kind: "form",
      state: { kind: "form", problem },
      sent,
      release: noRelease,
    };
    enter(owner, () => {
      const stops: (() => void)[] = [];
      if (mcpServerId !== null) stops.push(watchCatalogue(owner, mcpServerId));
      if (problem?.kind === "exists") {
        // The refusal's button leads to the server it names: its own record decides whether it is there.
        stops.push(
          followRecord(problem.mcpServerId, (reading) => {
            const existing = describeExisting(reading);
            const { state } = owner;
            if (
              state.problem?.kind !== "exists" ||
              sameExisting(state.problem.existing, existing)
            ) {
              return;
            }
            show(owner, { kind: "form", problem: { ...state.problem, existing } });
          }),
        );
      }
      return () => {
        for (const stop of stops) stop();
      };
    });
    // The list may already show that the server is gone, such as when a dialog opens after a delete.
    if (mcpServerId !== null) endIfCatalogueDisagrees(owner, mcpServerId);
  };

  /** Shows the phase `back` names, with `problem` for its form. */
  const returnToBack = (back: Back, problem: AttemptProblem | null): void => {
    if (back.kind === "form") enterForm(problem);
    else enterFollowing(back.origin, problem, back);
  };

  /** Turns a failure of a write into what the form shows. */
  const describeFailure = (error: unknown): AttemptProblem => {
    if (
      error instanceof ApiError &&
      error.code === "conflict" &&
      isConflictDetails(error.details)
    ) {
      const { details } = error;
      if (details.reason === "mcp-server-exists") {
        const cached = queries.readServers()?.find((server) => server.id === details.mcpServerId);
        // A cached name saves a blank frame. The read of the record decides what the button shows.
        const existing: ExistingServer =
          cached === undefined ? { kind: "reading" } : { kind: "found", name: cached.name };
        return { kind: "exists", mcpServerId: details.mcpServerId, existing };
      }
      return {
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

  // ---- following

  /** Shows what the followed record means now, or ends the attempt when the record says so. */
  const refresh = (owner: FollowingPhase): void => {
    if (phase !== owner || mcpServerId === null) return;
    const decided = decideFollowing({
      reading: owner.reading,
      origin: owner.origin,
      createdHere,
      mcpServerId,
      problem: owner.problem,
    });
    if (decided.kind === "ended") end(decided.reason, null, decided.name);
    else show(owner, { ...decided, check: owner.check });
  };

  /** Ends the wait of the pending "Check now" when the followed record is not what it held at the press. */
  const answerCheck = (owner: FollowingPhase): void => {
    const { pendingCheck, reading } = owner;
    if (pendingCheck === null || !pendingCheck.acknowledged || reading.kind !== "found") return;
    const { updatedAt, checkedAt } = reading.server;
    const { recordAtPress } = pendingCheck;
    if (
      recordAtPress === null ||
      recordAtPress.updatedAt !== updatedAt ||
      recordAtPress.checkedAt !== checkedAt
    ) {
      stopCheck(owner);
    }
  };

  /** Forgets the pending "Check now" and its timer. The caller shows the result. */
  const stopCheck = (owner: FollowingPhase): void => {
    if (owner.pendingCheck?.timer != null) clearTimeout(owner.pendingCheck.timer);
    owner.pendingCheck = null;
    owner.check = IDLE_CHECK_NOW;
  };

  /**
   * Follows the server after a write the controller acknowledged (or, with
   * `resume`, after a sign-in or a token write that did not lead on). `resume`
   * is what the phase showed before, which stays on screen until the first
   * read answers.
   */
  const enterFollowing = (
    origin: FollowOrigin,
    problem: AttemptProblem | null,
    resume?: { readonly server: McpServer | null; readonly outcome: ServerOutcome },
  ): void => {
    if (mcpServerId === null) return;
    const id = mcpServerId;
    const owner: FollowingPhase = {
      kind: "following",
      state: {
        kind: "following",
        mcpServerId: id,
        server: resume?.server ?? null,
        outcome: resume?.outcome ?? { kind: "reading" },
        problem,
        check: IDLE_CHECK_NOW,
      },
      origin,
      problem,
      reading: { kind: "pending" },
      check: IDLE_CHECK_NOW,
      pendingCheck: null,
      release: noRelease,
    };
    enter(owner, () => {
      const stopFollowing = followRecord(id, (reading) => {
        owner.reading = reading;
        if (reading.kind === "found") name = reading.server.name;
        answerCheck(owner);
        refresh(owner);
      });
      return () => {
        stopFollowing();
        if (owner.pendingCheck?.timer != null) clearTimeout(owner.pendingCheck.timer);
      };
    });
  };

  // ---- the token write

  const submitToken = (token: string): void => {
    const before = phase;
    const id = mcpServerId;
    if (id === null) return;
    let back: Back;
    if (before.kind === "form") back = { kind: "form" };
    else if (before.kind === "following" && before.state.outcome.kind === "needs-token") {
      back = {
        kind: "following",
        origin: before.origin,
        server: before.state.server,
        outcome: before.state.outcome,
      };
    } else return;
    const { canSubmit, issue } = readTokenField(token);
    if (!canSubmit) {
      const problem: AttemptProblem = {
        kind: "invalid",
        issues: { address: null, name: null, token: issue, other: null },
      };
      if (before.kind === "form") show(before, { kind: "form", problem });
      else {
        // Shows the refusal on the state the phase has now. A refresh would decide from the
        // record, which a resumed phase has not read yet, and replace the form with "Reading
        // the server…".
        before.problem = problem;
        show(before, { ...before.state, problem });
      }
      return;
    }
    const owner: WritingPhase = {
      kind: "writing",
      state: { kind: "writing", write: "token" },
      back,
      release: noRelease,
    };
    enter(owner);
    void (async () => {
      let failure: unknown;
      let saved = false;
      try {
        await client.mcpServer.setToken({ params: { id }, payload: { token } });
        saved = true;
      } catch (error) {
        failure = error;
      }
      // Whoever shows the server reads it again, whether or not this dialog is still open.
      invalidateServerPage(id);
      readCatalogueAgain();
      if (phase !== owner) return;
      if (saved) enterFollowing("token", null);
      else if (failure instanceof ApiError && failure.code === "not_found") end("gone", null, null);
      else if (failure instanceof ApiError && failure.code === "invalid_state") {
        // The record is reached with a Connection now, whose sign-in this form cannot write.
        end("moved", failure.message, null);
      } else returnToBack(back, describeFailure(failure));
    })();
  };

  // ---- the sign-in through the browser

  const browser = createBrowserSignIn({
    client,
    port: browserSignIn,
    isCurrent: (owner) => phase === owner,
    enter,
    show,
    end: (reason, message) => end(reason, message, null),
    follow: () => enterFollowing("sign-in", null),
    watchCatalogue,
    readAgainAfterWrite: (id) => {
      invalidateServerPage(id);
      readCatalogueAgain();
    },
  });

  const startSignIn = async (): Promise<void> => {
    const before = phase;
    const id = mcpServerId;
    if (id === null) return;
    let returnTo: SigningInPhase["returnTo"];
    if (before.kind === "signing-in" && before.state.step.kind === "refused") {
      ({ returnTo } = before);
    } else if (before.kind === "form" || before.kind === "following") {
      const back: Back =
        before.kind === "form"
          ? { kind: "form" }
          : {
              kind: "following",
              origin: before.origin,
              server: before.state.server,
              outcome: before.state.outcome,
            };
      returnTo = (problem) => returnToBack(back, problem);
    } else return;
    await browser.start(id, returnTo);
  };

  // ---- Check now

  const checkNow = async (): Promise<string | null> => {
    const owner = phase;
    if (owner.kind !== "following" || owner.pendingCheck !== null || mcpServerId === null) {
      return null;
    }
    const id = mcpServerId;
    const { reading } = owner;
    const pending: PendingCheck = {
      acknowledged: false,
      recordAtPress:
        reading.kind === "found"
          ? { updatedAt: reading.server.updatedAt, checkedAt: reading.server.checkedAt }
          : null,
      timer: null,
    };
    owner.pendingCheck = pending;
    owner.check = { busy: true, error: null };
    refresh(owner);
    let reason: string | null = null;
    try {
      await client.mcpServer.check({ params: { id } });
    } catch (error) {
      reason = readErrorMessage(error);
    }
    // Read again whether or not the check was accepted. The record may still be as it was: the
    // controller acknowledges the request and writes the answer when the check ends.
    invalidateServerPage(id);
    readCatalogueAgain();
    if (phase !== owner) return reason;
    if (reason !== null) {
      stopCheck(owner);
      owner.check = { busy: false, error: reason };
      refresh(owner);
      return reason;
    }
    pending.acknowledged = true;
    // The record may have changed while the reply was on its way.
    answerCheck(owner);
    if (owner.pendingCheck === pending) {
      pending.timer = setTimeout(() => {
        if (owner.pendingCheck !== pending) return;
        stopCheck(owner);
        refresh(owner);
      }, CHECK_ANSWER_WAIT_MILLIS);
    } else {
      refresh(owner);
    }
    return reason;
  };

  // ---- the attempt

  // A token form is about a server from the start, so it watches the list of servers from the start.
  if (mcpServerId !== null) enterForm(null);

  return {
    read: () => phase.state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    changeFields: (fields) => {
      const owner = phase;
      if (owner.kind !== "form" || owner.sent === null || owner.state.problem === null) return;
      if (owner.sent.address === fields.address && owner.sent.typedName === fields.typedName)
        return;
      enterForm(null);
    },
    submitAdd: (fields) => {
      const before = phase;
      if (target.kind !== "add" || before.kind !== "form" || mcpServerId !== null) return;
      const form = readAddForm(fields);
      if (!form.canSubmit) return;
      const owner: WritingPhase = {
        kind: "writing",
        state: { kind: "writing", write: "create" },
        back: { kind: "form" },
        release: noRelease,
      };
      enter(owner);
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
        if (phase !== owner) return;
        if (created !== undefined) {
          mcpServerId = created.id;
          name = created.name;
          createdHere = true;
          enterFollowing("create", null);
          return;
        }
        enterForm(describeFailure(failure), fields);
      })();
    },
    submitToken,
    startSignIn,
    finishSignInByPaste: async (pasted) => {
      if (phase.kind === "signing-in") await browser.finishByPaste(phase, pasted);
    },
    openSignInPage: async () => {
      if (phase.kind === "signing-in") await browser.openPage(phase);
    },
    cancelSignIn: () => {
      const owner = phase;
      if (owner.kind !== "signing-in" || owner.state.step.kind === "finishing") return;
      owner.returnTo(null);
    },
    retryRead: () => {
      const owner = phase;
      if (owner.kind !== "following" || owner.state.outcome.kind !== "read-failed") return;
      if (mcpServerId === null) return;
      owner.reading = { kind: "pending" };
      refresh(owner);
      invalidateServerPage(mcpServerId);
    },
    checkNow,
    close: () => {
      if (phase.kind === "ended" && phase.state.reason === "closed") return;
      enter({
        kind: "ended",
        state: { kind: "ended", reason: "closed", mcpServerId: null, name: null, message: null },
        release: noRelease,
      });
    },
  };
};

/** Returns what an Add refusal knows of the server it names, from the last read of that server's record. */
const describeExisting = (reading: RecordReading): ExistingServer => {
  switch (reading.kind) {
    case "pending":
      return { kind: "reading" };
    case "found":
      return { kind: "found", name: reading.server.name };
    case "gone":
      return { kind: "gone" };
    case "failed":
      return { kind: "unknown" };
  }
};

const sameExisting = (a: ExistingServer, b: ExistingServer): boolean =>
  a.kind === b.kind && (a.kind !== "found" || (b.kind === "found" && a.name === b.name));
