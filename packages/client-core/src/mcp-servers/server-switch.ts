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
 *   on its origin, writes nothing: it returns the candidates, and the app asks
 *   which one to replace (`replace`). Replace is one write that moves the chosen
 *   server onto the Connection and switches it on, under the guard of both the
 *   offer and the chosen server.
 * - A write's response is never put in the cache. The list of servers is read
 *   again after every write, and only that read fills the cache.
 *
 * The module has no React in it. An app passes its cache's shapes in a
 * `McpServerSwitchCache` and subscribes its controls to `readState`.
 */
import type { QueryClient, QueryKey } from "@tanstack/query-core";
import type { McpServer } from "@hercule/contract";
import type { HerculeClient } from "../client";
import { ApiError, readErrorMessage } from "../errors";
import { createEditGuard, type McpListEditState, type McpListRefusal } from "./edit-guard";
import type { OfferedServer } from "./offers";
import { readBaseAfterWrite, type McpListQuery } from "./reconcile";
import { findReplaceCandidates } from "./replace";

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

/**
 * Where the Replace dialog of an offer stands. The dialog draws it and decides
 * nothing: it closes on `replaced`, and keeps its refusal and link on `refused`.
 */
export type ReplaceProgress =
  /** Nothing was confirmed: the user is still choosing, and the offer has no record. */
  | { readonly kind: "choosing" }
  /** The user confirmed `serverId`. The write, or the read of the list after it, is not done. The dialog keeps `serverId` selected. */
  | { readonly kind: "writing"; readonly serverId: string }
  /** The write of `serverId` succeeded, and the list shows it on the offer's Connection. */
  | { readonly kind: "replaced"; readonly serverId: string }
  /**
   * Nothing was replaced. `message` says why. `winnerServerId` is the server
   * that holds the offer's Connection when there is one, which the dialog
   * links to: another client's server that appeared while the user was
   * choosing or while the confirmed write was held, or the one the controller
   * named. `serverId` is the one the user confirmed, or `null`.
   */
  | {
      readonly kind: "refused";
      readonly serverId: string | null;
      readonly message: string;
      readonly winnerServerId: string | null;
    };

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
   * servers added by URL sit on its origin, `candidates` in the order of the
   * list. The app asks which one to replace, and `replace` writes the answer.
   */
  | { readonly kind: "replace"; readonly candidates: readonly McpServer[] };

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
   * nothing and returns `replace` with the candidates, resolved from the
   * cache at this moment.
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
   * Moves the server added by URL `serverId` onto the plugin target, and
   * switches it on, in one `mcpServer.update` (`source` and `enabled: true`:
   * the user pressed On). The write is bound to the server the user chose: it
   * is never changed to another candidate meanwhile, and a candidate the user
   * did not confirm is never used.
   *
   * Does nothing while the offer or the chosen server is blocked. It is
   * refused, with a reason and no write, when the cache holds no list, no
   * longer holds the chosen server as a server added by URL on the offer's
   * origin, or already holds a record for the target. A write the controller
   * refuses (`not_found`, `invalid_state`, `validation`, or `mcp-server-exists`
   * for the target's external account) leaves the refusal on the plugin
   * target, the list read again, and the chosen server's page marked stale. For
   * `mcp-server-exists` the refusal names the server that won.
   */
  readonly replace: (target: McpServerSwitchTarget, serverId: string) => void;
  /**
   * Returns where the Replace of the plugin target stands, from the
   * confirmed write and the servers the cache holds now. A record on the
   * target that is not the confirmed server, or that appeared before any
   * confirmation, is a winner: it is `refused` with a link to it, never
   * `replaced`, whether it arrives before the press or while the write is
   * held. `replaced` needs the confirmed server's own record. A target that is
   * not a plugin's is always `choosing`.
   */
  readonly readReplaceProgress: (target: McpServerSwitchTarget) => ReplaceProgress;
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

/** Returns the id of the server a refusal names as the holder of what the write wanted (`mcp-server-exists`), as a field to spread into a refusal. */
const readExistingServerId = (failure: unknown): { readonly existingServerId?: string } => {
  if (!(failure instanceof ApiError) || failure.code !== "conflict") return {};
  const { details } = failure;
  return typeof details === "object" &&
    details !== null &&
    "reason" in details &&
    details.reason === "mcp-server-exists" &&
    "mcpServerId" in details &&
    typeof details.mcpServerId === "string"
    ? { existingServerId: details.mcpServerId }
    : {};
};

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
  guard.subscribe(() => {
    for (const key of pressedAgainst.keys()) {
      const { refusal, blocked } = guard.readState(key);
      if (refusal === null && !blocked) pressedAgainst.delete(key);
    }
  });
  const readReplaceProgress = (target: McpServerSwitchTarget): ReplaceProgress => {
    if (target.kind !== "plugin") return { kind: "choosing" };
    const key = buildTargetKey(target);
    const confirmed = confirmedReplaces.get(key);
    const record = findRecord(cache.readServers() ?? [], target);
    const winner = record !== undefined && record.id !== confirmed?.serverId ? record.id : null;
    const { refusal } = guard.readState(key);
    if (refusal?.kind === "refused") {
      return {
        kind: "refused",
        serverId: confirmed?.serverId ?? null,
        message: refusal.message,
        winnerServerId: refusal.existingServerId ?? winner,
      };
    }
    if (winner !== null) {
      return {
        kind: "refused",
        serverId: confirmed?.serverId ?? null,
        message: "Nothing was replaced. This Connection's server was added meanwhile.",
        winnerServerId: winner,
      };
    }
    if (confirmed === undefined) return { kind: "choosing" };
    return record?.id === confirmed.serverId && confirmed.saved
      ? { kind: "replaced", serverId: confirmed.serverId }
      : { kind: "writing", serverId: confirmed.serverId };
  };
  const stateWithoutRefusal = new WeakMap<McpListEditState, McpListEditState>();
  /** The server each offer's Replace was confirmed for, and whether its write succeeded. Dropped with the refusal. */
  const confirmedReplaces = new Map<string, { readonly serverId: string; saved: boolean }>();

  /**
   * Runs the write, then reads the list of servers again, on its own
   * (`readBaseAfterWrite`), and releases the keys when that read succeeded.
   * The cache still lacks the change until then, and a press built on it would
   * undo it. The pages of the servers the write touched are marked stale and
   * read again if somebody shows them, without holding the keys.
   *
   * `keys` are the targets the write holds, the first one carries the
   * refusal. `pageIds` are the servers whose pages the write may have changed.
   */
  const run = async ({
    keys,
    pageIds,
    write,
    failurePrefix = "",
  }: {
    readonly keys: readonly [string, ...string[]];
    readonly pageIds: readonly string[];
    readonly write: () => Promise<unknown>;
    readonly failurePrefix?: string;
  }): Promise<void> => {
    let saved = false;
    let failure: unknown = undefined;
    try {
      await write();
      saved = true;
    } catch (error) {
      failure = error;
    }
    for (const id of pageIds) {
      void queryClient.invalidateQueries({ queryKey: cache.readPageKey(id), exact: true });
    }
    // A refusal can mean the cache was out of date, such as the `conflict` of a second server for one Connection.
    const read = await readBaseAfterWrite(queryClient, cache.readCatalogue());
    const wasRead = read.hasSucceeded();
    if (wasRead) read.stop();
    const refusal: McpListRefusal | null = saved
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
        if (candidates.length > 0) return { kind: "replace", candidates };
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
    replace: (target, serverId) => {
      if (target.kind !== "plugin") return;
      const offerKey = buildTargetKey(target);
      const chosenKey = buildTargetKey({ kind: "url", serverId });
      if (guard.isBlocked(offerKey) || guard.isBlocked(chosenKey)) return;
      /** The refusal stays whatever the cache shows of the target later: a winner that appears is what it points at. */
      const refuse = (message: string, existingServerId?: string): void => {
        pressedAgainst.set(offerKey, KEEP_REFUSAL);
        guard.refuse(offerKey, {
          kind: "refused",
          message: `Nothing was replaced. ${message}`,
          ...(existingServerId === undefined ? {} : { existingServerId }),
        });
      };
      const servers = cache.readServers();
      if (servers === undefined) {
        refuse("The servers are not read yet. Try again.");
        return;
      }
      const winner = findRecord(servers, target);
      if (winner !== undefined) {
        refuse("This Connection's server was added meanwhile.", winner.id);
        return;
      }
      const origin = cache.readOfferOrigin(target.contributionId);
      const candidates = origin === undefined ? [] : findReplaceCandidates({ origin }, servers);
      if (!candidates.some((candidate) => candidate.id === serverId)) {
        refuse(
          "The server you chose is gone, or is no longer added by URL on this address. Choose again.",
        );
        return;
      }
      pressedAgainst.set(offerKey, KEEP_REFUSAL);
      guard.start(offerKey);
      guard.start(chosenKey);
      const confirmed = { serverId, saved: false };
      confirmedReplaces.set(offerKey, confirmed);
      const { contributionId, connectionId } = target;
      void run({
        keys: [offerKey, chosenKey],
        pageIds: [serverId],
        write: async () => {
          await client.mcpServer.update({
            params: { id: serverId },
            payload: { source: { kind: "plugin", contributionId, connectionId }, enabled: true },
          });
          confirmed.saved = true;
        },
        failurePrefix: "Nothing was replaced. ",
      });
    },
    readReplaceProgress,
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
      confirmedReplaces.delete(buildTargetKey(target));
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
