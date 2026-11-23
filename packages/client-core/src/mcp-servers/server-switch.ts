/**
 * The switch of an MCP server (spec 17, Settings > MCP servers): on a row of
 * the list and on a server's page, in both apps. One module owns every press,
 * so the rules hold in one place:
 *
 * - A switch has a target, and one write runs per target at a time, whichever
 *   control started it (`createEditGuard`). The target of a plugin's server is
 *   its contribution and its Connection, which stays the same whether the
 *   server has a record or not. The target of a server added by URL is its
 *   record id.
 * - Whether a press creates the server or updates its record is decided when
 *   the press runs, from the servers the cache holds then. A record that
 *   another client created, or that a read brought in while a create runs,
 *   turns the next press into an update.
 * - Switching an offer on, when it has no record and a server added by URL sits
 *   on its origin, writes nothing: the app opens the Replace dialog
 *   (`openReplace`) and asks which server to replace. The switches hold that
 *   dialog's whole model, from the press to the read after the write: the
 *   pick, the servers as they were shown at the confirmation, and the outcome.
 *   `readReplaceDialog` returns everything the dialog draws. Replace is one
 *   write that moves the chosen server onto the Connection and switches it
 *   on, under the guard of both the offer and the chosen server.
 * - A write's response is never put in the cache. The list of servers is read
 *   again after every write, and only that read fills the cache.
 *
 * The module has no React in it. An app passes its cache's shapes in a
 * `McpServerSwitchCache` and subscribes its controls to `readState`.
 */
import { matchQuery, type QueryClient, type QueryKey } from "@tanstack/query-core";
import { ConflictDetails, type McpServer } from "@hercule/contract";
import { Schema } from "effect";
import type { HerculeClient } from "../client";
import { ApiError, ConnectionError, readErrorMessage } from "../errors";
import { createEditGuard, type McpListEditState, type McpListRefusal } from "./edit-guard";
import type { OfferedServer } from "./offers";
import { readBaseAfterWrite, type McpListQuery } from "./reconcile";
import {
  buildReplaceDialogView,
  findReplaceCandidates,
  type ReplaceDialogView,
  type ReplaceOutcome,
} from "./replace";

/** The server a switch turns on and off. */
export type McpServerSwitchTarget =
  /** A server a plugin offers on a Connection. It may have no record yet. */
  | {
      readonly kind: "plugin";
      readonly contributionId: string;
      readonly connectionId: string;
    }
  /** A server added by URL, which always has a record. */
  | { readonly kind: "url"; readonly serverId: string };

/** Returns the target of the switch of an offer on a Connection, whether or not it has a record. */
export const buildOfferSwitchTarget = ({
  offer,
  connection,
}: Pick<OfferedServer, "offer" | "connection">): McpServerSwitchTarget => ({
  kind: "plugin",
  contributionId: offer.contributionId,
  connectionId: connection.id,
});

/**
 * Returns the target of the switch on the page of `server`, from the source
 * the record stores. A plugin's server gets the same target as its row in the
 * list, so the page and the row share one guard.
 */
export const buildServerSwitchTarget = (server: McpServer): McpServerSwitchTarget =>
  server.source.kind === "plugin"
    ? {
        kind: "plugin",
        contributionId: server.source.contributionId,
        connectionId: server.source.connectionId,
      }
    : { kind: "url", serverId: server.id };

/** What the switch on a server's page shows. */
export interface ServerPageSwitch {
  /** Whether the switch is on: the server's record in the list of servers, else the page's own read. */
  readonly on: boolean;
  /**
   * Why the switch cannot be pressed now, or `null` when the page and the
   * list agree. It is set while the list has no record of the server, and
   * while the page's read of the server shows another value than the list,
   * because that read is still running or failed.
   */
  readonly waitReason: string | null;
}

/**
 * Decides what the switch on the page of `page` shows. A press is decided on
 * the server's record in the list of servers (`catalogued`, `undefined` when
 * the list has no record of it), so the switch shows that record. When the
 * list has no record, the server was deleted and the page still shows its
 * last read: the switch waits and says so. When the page's own read shows
 * another value, a press could land on an old one: the switch then waits and
 * says why. `pageReadFailed` tells whether the page's last read failed, and
 * `reload` is the app's words for opening the page again ("Reload the page",
 * "Reopen the page"), used in the reason of a failed read.
 */
export const decideServerPageSwitch = ({
  page,
  catalogued,
  pageReadFailed,
  reload,
}: {
  readonly page: McpServer;
  readonly catalogued: McpServer | undefined;
  readonly pageReadFailed: boolean;
  readonly reload: string;
}): ServerPageSwitch => {
  if (catalogued === undefined) {
    return {
      on: page.enabled,
      waitReason: "This server is not in the list of servers any more, so the switch waits.",
    };
  }
  const lags = catalogued.enabled !== page.enabled;
  return {
    on: catalogued.enabled,
    waitReason: !lags
      ? null
      : pageReadFailed
        ? `This page could not read the server again, so the switch waits. ${reload} to try again.`
        : "This page is reading the server again, so the switch waits.",
  };
};

/** How an app's cache holds what a switch reads. The module decides everything else. */
export interface McpServerSwitchCache {
  /** Returns the servers the cache holds now, or `undefined` while the list is not cached. */
  readServers(): readonly McpServer[] | undefined;
  /**
   * Returns the query that reads the list of servers. After a write the
   * module reads it again, and keeps the target blocked until that read
   * succeeds.
   */
  readCatalogue(): McpListQuery;
  /**
   * Returns the address a plugin's server is reached at (the offer's `origin`),
   * or `undefined` when no plugin offers `contributionId`. A press that would
   * create the server looks for a server added by URL on that origin first.
   */
  readOfferOrigin(contributionId: string): string | undefined;
  /** Returns the key of the read of one server's page. After a write to that server it is marked stale and read again if somebody observes it. */
  readPageKey(serverId: string): QueryKey;
}

/** What a press on the switch did. */
export type McpServerSwitchPress =
  /** The press ran, was refused (`readState` says why) or had nothing to do. */
  | { readonly kind: "handled" }
  /**
   * Nothing was written. The press would have created the plugin's server, but
   * servers added by URL sit on its origin. The app opens the Replace dialog
   * (`openReplace`), which asks which one to replace.
   */
  | { readonly kind: "replace" };

/** The switches of MCP servers. */
export interface McpServerSwitches {
  /**
   * Switches the target's server `on` or off: creates it when the cache holds
   * no record of it, updates its record otherwise. Does nothing while the
   * target is blocked, and for an off of a server with no record. The guard is
   * taken before this returns, so a second call in the same tick does nothing.
   *
   * A press that switches a plugin's server on while the cache holds no record
   * of it, and a server added by URL sits on the offer's origin, writes
   * nothing and returns `replace`.
   *
   * A control that shows an existing record, such as a server's page, passes
   * that record's id as `existingRecordId`. The press then only ever updates
   * that record: when the cache no longer holds it (it was deleted, or it was
   * deleted and created again under a new id), the press is refused with a
   * reason and writes nothing, so it can never create a server.
   */
  readonly apply: (
    target: McpServerSwitchTarget,
    on: boolean,
    existingRecordId?: string,
  ) => McpServerSwitchPress;
  /**
   * Opens the Replace dialog of the plugin target, after a press returned
   * `replace`. The servers added by URL on the offer's origin are read from the
   * cache now. When there is exactly one, it is the chosen server: the dialog
   * asks about it, and that is not a choice among several. With several,
   * nothing is chosen. `connectionLabel` and `typeName` (such as "Sentry")
   * name the Connection in the dialog's words. A dialog opened before is
   * replaced. Does nothing for a target that is not a plugin's.
   */
  readonly openReplace: (
    target: McpServerSwitchTarget,
    words: { readonly connectionLabel: string; readonly typeName: string },
  ) => void;
  /**
   * Returns everything the Replace dialog of the plugin target draws, or `null`
   * while no dialog is open. The list of servers is followed live: a server
   * that left is not offered, and one that appeared is, to be chosen. What the
   * user confirmed stays fixed, name and address included, until the write
   * and the read of the list after it are done.
   *
   * - A record on the target that is not the confirmed server is a winner: the
   *   dialog shows a refusal with a link to it, never `done`, whether it
   *   arrives before the confirmation or while the write is held.
   * - `done` needs the confirmed server's own record in the list read after
   *   the write. When that read answers without it (deleted or moved
   *   meanwhile) the dialog shows a refusal.
   * - A write whose reply was lost (the controller could not be reached) is
   *   settled by that same read: the confirmed server on the Connection is
   *   `done`, without a word about who wrote it; otherwise the dialog says
   *   nothing was replaced, because the list shows nothing moved. While the
   *   list cannot be read, the dialog says the outcome is unknown.
   * - When the write is saved and the list cannot be read, the dialog says so
   *   and offers `readReplaceListAgain`.
   * - After a refusal that left the chosen server out of the candidates,
   *   nothing is chosen, even with one candidate left.
   *
   * The returned object is the same one while nothing it shows changed.
   */
  readonly readReplaceDialog: (target: McpServerSwitchTarget) => ReplaceDialogView | null;
  /**
   * Calls `listener` whenever `readReplaceDialog` may return something else:
   * when a switch changes, when the list of servers changes, and when the
   * dialog is opened, picked in, or closed. Other changes of the query cache do
   * not call it. Returns the function that stops it.
   */
  readonly subscribeReplaceDialog: (listener: () => void) => () => void;
  /** Chooses the candidate `serverId` in the open Replace dialog. Does nothing while the choice is locked, or for a server that is not listed. */
  readonly pickReplaceServer: (target: McpServerSwitchTarget, serverId: string) => void;
  /**
   * Replaces the chosen server of the open dialog: moves it onto the plugin
   * target and switches it on, in one `mcpServer.update` (`source` and
   * `enabled: true`: the user pressed On). The write is bound to the server
   * the user chose, and a candidate the user did not choose is never used.
   * Does nothing unless `readReplaceDialog` says `canReplace`. That covers a
   * write that runs on the offer or on the chosen server, and the guard of
   * both is held until the list is read again.
   *
   * A write the controller refuses (`not_found`, `invalid_state`, `validation`,
   * or `conflict`) leaves the refusal in the dialog, the list read again, and
   * the chosen server's page marked stale. For `mcp-server-exists` the refusal
   * names the server that won.
   */
  readonly confirmReplace: (target: McpServerSwitchTarget) => void;
  /** Reads the list of servers again, when the dialog says it could not (`readAgainLabel`). The dialog says so while it reads. */
  readonly readReplaceListAgain: (target: McpServerSwitchTarget) => void;
  /** Closes the Replace dialog and forgets its refusal. A write that still runs keeps its guard until it ends. */
  readonly closeReplace: (target: McpServerSwitchTarget) => void;
  /** Returns what a control shows of the target. */
  readonly readState: (target: McpServerSwitchTarget) => McpListEditState;
  /** Forgets the target's refusal, when the user dismisses it. */
  readonly clearRefusal: (target: McpServerSwitchTarget) => void;
  /**
   * Counts the caller as a control that shows the target's state. A refusal
   * stays while one does. After the last one has left, a refusal is dropped
   * after `DETACHED_REFUSAL_LIFETIME_MS`. Returns the function that detaches.
   */
  readonly attach: (target: McpServerSwitchTarget) => () => void;
  /** Calls `listener` whenever the state of any target changes. Returns the function that stops it. */
  readonly subscribe: (listener: () => void) => () => void;
}

const isConflictDetails = Schema.is(ConflictDetails);

/** Returns the id of the server a refusal names as the holder of what the write wanted (`mcp-server-exists`), as a field to spread into a refusal. */
const readExistingServerId = (failure: unknown): { readonly existingServerId?: string } =>
  failure instanceof ApiError &&
  failure.code === "conflict" &&
  isConflictDetails(failure.details) &&
  failure.details.reason === "mcp-server-exists"
    ? { existingServerId: failure.details.mcpServerId }
    : {};

/** A refusal made against this value is shown whatever record the target has later: it points at a record that appeared. */
const KEEP_REFUSAL = Symbol("keep refusal");

const HANDLED: McpServerSwitchPress = { kind: "handled" };

const buildTargetKey = (target: McpServerSwitchTarget): string =>
  target.kind === "plugin"
    ? `plugin:${target.contributionId}:${target.connectionId}`
    : `url:${target.serverId}`;

const findRecord = (
  servers: readonly McpServer[],
  target: McpServerSwitchTarget,
): McpServer | undefined =>
  servers.find(({ id, source }) =>
    target.kind === "url"
      ? id === target.serverId
      : source.kind === "plugin" &&
        source.contributionId === target.contributionId &&
        source.connectionId === target.connectionId,
  );

/**
 * Creates the switches of MCP servers over `queryClient`, writing through
 * `client` and reading the cache's shapes through `cache`. An app uses one
 * instance for its query client (see `findOrCreateMcpServerSwitches`).
 */
export const createMcpServerSwitches = ({
  queryClient,
  client,
  cache,
}: {
  readonly queryClient: QueryClient;
  readonly client: HerculeClient;
  readonly cache: McpServerSwitchCache;
}): McpServerSwitches => {
  const guard = createEditGuard();
  /**
   * The id of the record a target had when it was pressed, `null` for none: the
   * state its refusal was made from. An entry lives as long as the refusal it
   * belongs to, so it is dropped when the guard drops the refusal.
   */
  const pressedAgainst = new Map<string, string | null | typeof KEEP_REFUSAL>();
  /** The write the user confirmed in a Replace dialog, and how far it got. */
  interface ConfirmedReplace {
    readonly serverId: string;
    /** The candidates the dialog listed at the confirmation. The write can move the chosen one off the list, and the dialog still names it. */
    readonly shown: readonly McpServer[];
    /** True when the write failed because the controller could not be reached: the write may or may not have committed. */
    replyLost: boolean;
    /** True once a read of the list after the write answered. */
    listRead: boolean;
  }
  /** One open Replace dialog: its words, the user's pick, and the confirmation once there is one. */
  interface ReplaceAttempt {
    readonly connectionLabel: string;
    readonly typeName: string;
    pickedId: string | null;
    confirmed: ConfirmedReplace | null;
    /** True while a read the user asked for runs. */
    rereading: boolean;
  }
  const replaceAttempts = new Map<string, ReplaceAttempt>();
  const replaceListeners = new Set<() => void>();
  const notifyReplace = (): void => {
    for (const listener of [...replaceListeners]) listener();
  };

  guard.subscribe(() => {
    for (const key of pressedAgainst.keys()) {
      const { refusal, blocked } = guard.readState(key);
      if (refusal === null && !blocked) pressedAgainst.delete(key);
    }
  });

  const lastViews = new Map<string, ReplaceDialogView>();
  /** Returns `view`, or the object returned before when it shows the same, so a reader can compare by identity. */
  const keepStable = (key: string, view: ReplaceDialogView): ReplaceDialogView => {
    const before = lastViews.get(key);
    if (before !== undefined && JSON.stringify(before) === JSON.stringify(view)) return before;
    lastViews.set(key, view);
    return view;
  };

  const decideReplaceOutcome = (
    key: string,
    attempt: ReplaceAttempt,
    record: McpServer | undefined,
    servers: readonly McpServer[],
  ): ReplaceOutcome => {
    const { confirmed } = attempt;
    const winner = record !== undefined && record.id !== confirmed?.serverId ? record.id : null;
    const { refusal, unread } = guard.readState(key);
    const unreadNote = unread === null ? "" : " The list of servers could not be read again.";
    if (refusal?.kind === "refused") {
      return {
        kind: "refused",
        message: `${refusal.message}${unreadNote}`,
        winnerServerId: refusal.existingServerId ?? winner,
        unread: unread !== null,
      };
    }
    if (winner !== null) {
      return {
        kind: "refused",
        message: `Nothing was replaced. This Connection's server was added meanwhile.${unreadNote}`,
        winnerServerId: winner,
        unread: unread !== null,
      };
    }
    if (confirmed === null) return { kind: "choosing" };
    if (!confirmed.listRead) {
      if (attempt.rereading) return { kind: "working", message: "Reading the list again…" };
      if (unread !== null) {
        return {
          kind: "unread",
          message: confirmed.replyLost
            ? "The controller's reply was lost and the list of servers could not be read, so it is not known whether the server was replaced."
            : "The server was replaced, but the list of servers could not be read again, so the result is not shown yet.",
        };
      }
      return { kind: "working", message: "Replacing…" };
    }
    if (record !== undefined) return { kind: "replaced" };
    const stillListed = servers.some(({ id }) => id === confirmed.serverId);
    return {
      kind: "refused",
      message: confirmed.replyLost
        ? `Nothing was replaced. The controller's reply was lost, and the list shows ${stillListed ? "the server did not move" : "no server on this Connection"}.`
        : "The server you chose was removed or moved by another client right after the write, so it is not on this Connection.",
      winnerServerId: null,
      unread: false,
    };
  };

  const readReplaceCandidates = (
    target: McpServerSwitchTarget & { kind: "plugin" },
  ): McpServer[] => {
    const origin = cache.readOfferOrigin(target.contributionId);
    return origin === undefined ? [] : findReplaceCandidates({ origin }, cache.readServers() ?? []);
  };

  const readReplaceDialog = (target: McpServerSwitchTarget): ReplaceDialogView | null => {
    if (target.kind !== "plugin") return null;
    const key = buildTargetKey(target);
    const attempt = replaceAttempts.get(key);
    if (attempt === undefined) return null;
    const servers = cache.readServers() ?? [];
    const record = findRecord(servers, target);
    return keepStable(
      key,
      buildReplaceDialogView({
        connectionLabel: attempt.connectionLabel,
        typeName: attempt.typeName,
        servers,
        live: readReplaceCandidates(target),
        pickedId: attempt.pickedId,
        confirmed: attempt.confirmed,
        outcome: decideReplaceOutcome(key, attempt, record, servers),
        occupied: record !== undefined,
        offerBlocked: guard.isBlocked(key),
        isServerBlocked: (serverId) => guard.isBlocked(buildTargetKey({ kind: "url", serverId })),
      }),
    );
  };
  const stateWithoutRefusal = new WeakMap<McpListEditState, McpListEditState>();

  /**
   * Runs the write, then reads the list of servers again, on its own
   * (`readBaseAfterWrite`), and releases the keys when that read succeeded.
   * The cache still lacks the change until then, and a press built on it would
   * undo it. The pages of the servers the write touched are marked stale and
   * read again if somebody shows them, without holding the keys.
   *
   * `keys` are the targets the write holds, the first one carries the
   * refusal. `pageIds` are the servers whose pages the write may have changed.
   * `onListRead` is called, before the keys are released, once a read of the
   * list after the write has succeeded: at once, or later when the first read
   * failed or is held. It is called for a write that was saved, and for one
   * whose reply was lost.
   *
   * A write that fails because the controller could not be reached may have
   * committed. When `onLostReply` is given it is called then, and the failure
   * leaves no refusal: the read of the list decides what happened. Without
   * it, such a failure is a refusal like any other.
   */
  const run = async ({
    keys,
    pageIds,
    write,
    failurePrefix = "",
    onListRead,
    onLostReply,
  }: {
    readonly keys: readonly [string, ...string[]];
    readonly pageIds: readonly string[];
    readonly write: () => Promise<unknown>;
    readonly failurePrefix?: string;
    readonly onListRead?: () => void;
    readonly onLostReply?: () => void;
  }): Promise<void> => {
    let saved = false;
    let replyLost = false;
    let failure: unknown = undefined;
    try {
      await write();
      saved = true;
    } catch (error) {
      if (onLostReply !== undefined && error instanceof ConnectionError) {
        onLostReply();
        replyLost = true;
      } else {
        failure = error;
      }
    }
    for (const id of pageIds) {
      void queryClient.invalidateQueries({ queryKey: cache.readPageKey(id), exact: true });
    }
    // A refusal can mean the cache was out of date, such as the `conflict` of a second server for one Connection.
    const read = await readBaseAfterWrite(queryClient, cache.readCatalogue());
    const wasRead = read.hasSucceeded();
    if (onListRead !== undefined && (saved || replyLost)) read.whenSucceeded(onListRead);
    if (wasRead) read.stop();
    const refusal: McpListRefusal | null =
      saved || replyLost
        ? null
        : {
            kind: "refused",
            message: `${failurePrefix}${readErrorMessage(failure)}`,
            ...readExistingServerId(failure),
          };
    for (const [index, key] of keys.entries()) {
      guard.finish(key, {
        refusal: index === 0 ? refusal : null,
        unread: wasRead ? null : { saved, read },
      });
    }
  };

  return {
    apply: (target, on, existingRecordId) => {
      const key = buildTargetKey(target);
      if (guard.isBlocked(key)) return HANDLED;
      const servers = cache.readServers();
      const record = servers === undefined ? undefined : findRecord(servers, target);
      /** Records what the press was made against, just before it leaves a refusal or starts a write. */
      const refuse = (message: string): McpServerSwitchPress => {
        pressedAgainst.set(key, record?.id ?? null);
        guard.refuse(key, { kind: "refused", message });
        return HANDLED;
      };
      if (servers === undefined) {
        return refuse("The servers are not read yet, so nothing was changed. Try again.");
      }
      let write: () => Promise<unknown>;
      if (existingRecordId !== undefined && record?.id !== existingRecordId) {
        return refuse("This server no longer exists, so nothing was changed.");
      } else if (record !== undefined) {
        write = () =>
          client.mcpServer.update({ params: { id: record.id }, payload: { enabled: on } });
      } else if (target.kind === "url") {
        return refuse("This server no longer exists, so nothing was changed.");
      } else if (!on) {
        // A server that was never switched on has nothing to switch off.
        return HANDLED;
      } else {
        const { contributionId, connectionId } = target;
        const origin = cache.readOfferOrigin(contributionId);
        const candidates = origin === undefined ? [] : findReplaceCandidates({ origin }, servers);
        if (candidates.length > 0) return { kind: "replace" };
        write = () =>
          client.mcpServer.create({
            payload: { source: { kind: "plugin", contributionId, connectionId } },
          });
      }
      pressedAgainst.set(key, record?.id ?? null);
      guard.start(key);
      void run({ keys: [key], pageIds: record === undefined ? [] : [record.id], write });
      return HANDLED;
    },
    openReplace: (target, { connectionLabel, typeName }) => {
      if (target.kind !== "plugin") return;
      const candidates = readReplaceCandidates(target);
      // Exactly one candidate is the server the dialog asks about, which is not a choice.
      replaceAttempts.set(buildTargetKey(target), {
        connectionLabel,
        typeName,
        pickedId: candidates.length === 1 ? candidates[0]!.id : null,
        confirmed: null,
        rereading: false,
      });
      notifyReplace();
    },
    readReplaceDialog,
    subscribeReplaceDialog: (listener) => {
      const stopSwitches = guard.subscribe(listener);
      const stopCache = queryClient.getQueryCache().subscribe((event) => {
        if (
          (event.type === "added" || event.type === "updated" || event.type === "removed") &&
          matchQuery({ queryKey: cache.readCatalogue().queryKey, exact: true }, event.query)
        ) {
          listener();
        }
      });
      replaceListeners.add(listener);
      return () => {
        stopSwitches();
        stopCache();
        replaceListeners.delete(listener);
      };
    },
    pickReplaceServer: (target, serverId) => {
      const view = readReplaceDialog(target);
      if (view === null || view.locked) return;
      if (view.choices?.some((choice) => choice.serverId === serverId) !== true) return;
      replaceAttempts.get(buildTargetKey(target))!.pickedId = serverId;
      notifyReplace();
    },
    confirmReplace: (target) => {
      const view = readReplaceDialog(target);
      if (view === null || !view.canReplace || target.kind !== "plugin") return;
      const serverId = view.selectedId!;
      const offerKey = buildTargetKey(target);
      const chosenKey = buildTargetKey({ kind: "url", serverId });
      const confirmed: ConfirmedReplace = {
        serverId,
        shown: readReplaceCandidates(target),
        replyLost: false,
        listRead: false,
      };
      // The refusal stays whatever the cache shows of the target later: a winner that appears is what it points at.
      pressedAgainst.set(offerKey, KEEP_REFUSAL);
      // The confirmation is stored before the guard notifies: the first notification must already
      // read `locked`, and nothing notifies a reader after the guard starts.
      replaceAttempts.get(offerKey)!.confirmed = confirmed;
      guard.start(offerKey);
      guard.start(chosenKey);
      const { contributionId, connectionId } = target;
      void run({
        keys: [offerKey, chosenKey],
        pageIds: [serverId],
        write: () =>
          client.mcpServer.update({
            params: { id: serverId },
            payload: { source: { kind: "plugin", contributionId, connectionId }, enabled: true },
          }),
        failurePrefix: "Nothing was replaced. ",
        onListRead: () => {
          confirmed.listRead = true;
        },
        onLostReply: () => {
          confirmed.replyLost = true;
        },
      });
    },
    readReplaceListAgain: (target) => {
      const attempt = replaceAttempts.get(buildTargetKey(target));
      if (attempt === undefined || attempt.rereading) return;
      attempt.rereading = true;
      notifyReplace();
      void cache
        .readCatalogue()
        .fetch()
        .catch(() => {})
        .finally(() => {
          attempt.rereading = false;
          notifyReplace();
        });
    },
    closeReplace: (target) => {
      const key = buildTargetKey(target);
      if (!replaceAttempts.delete(key)) return;
      lastViews.delete(key);
      guard.clearRefusal(key);
      notifyReplace();
    },
    readState: (target) => {
      const key = buildTargetKey(target);
      const state = guard.readState(key);
      if (state.refusal === null) return state;
      // A refusal describes the row as it was pressed. Once the cache shows another record for the
      // target, such as a server that another client created, the refusal no longer describes it.
      const now = findRecord(cache.readServers() ?? [], target)?.id ?? null;
      const pressed = pressedAgainst.get(key);
      if (pressed === KEEP_REFUSAL || pressed === now) return state;
      let without = stateWithoutRefusal.get(state);
      if (without === undefined) {
        without = { ...state, refusal: null };
        stateWithoutRefusal.set(state, without);
      }
      return without;
    },
    clearRefusal: (target) => {
      guard.clearRefusal(buildTargetKey(target));
    },
    attach: (target) => guard.attach(buildTargetKey(target)),
    subscribe: guard.subscribe,
  };
};

const sharedSwitches = new WeakMap<QueryClient, McpServerSwitches>();

/**
 * Returns the switches of `queryClient`, creating them with `options` the
 * first time. There is one instance for each query client, so the switch of a
 * row and the switch of the same server's page share one guard and one
 * refusal.
 */
export const findOrCreateMcpServerSwitches = (options: {
  readonly queryClient: QueryClient;
  readonly client: HerculeClient;
  readonly cache: McpServerSwitchCache;
}): McpServerSwitches => {
  const found = sharedSwitches.get(options.queryClient);
  if (found !== undefined) return found;
  const created = createMcpServerSwitches(options);
  sharedSwitches.set(options.queryClient, created);
  return created;
};
