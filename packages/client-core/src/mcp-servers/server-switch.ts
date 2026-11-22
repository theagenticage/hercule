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
 * - A write's response is never put in the cache. The list of servers is read
 *   again after every write, and only that read fills the cache.
 *
 * The module has no React in it. An app passes its cache's shapes in a
 * `McpServerSwitchCache` and subscribes its controls to `readState`.
 */
import type { QueryClient, QueryKey } from "@tanstack/query-core";
import type { McpServer } from "@hercule/contract";
import type { HerculeClient } from "../client";
import { readErrorMessage } from "../errors";
import { createEditGuard, type McpListEditState } from "./edit-guard";
import type { OfferedServer } from "./offers";
import { readBaseAfterWrite, type McpListQuery } from "./reconcile";

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
  /** Returns the key of the read of one server's page. After a write to that server it is marked stale and read again if somebody observes it. */
  readPageKey(serverId: string): QueryKey;
}

/** The switches of MCP servers. */
export interface McpServerSwitches {
  /**
   * Switches the target's server `on` or off: creates it when the cache holds
   * no record of it, updates its record otherwise. Does nothing while the
   * target is blocked, and for an off of a server with no record. The guard is
   * taken before this returns, so a second call in the same tick does nothing.
   *
   * A control that shows an existing record, such as a server's page, passes
   * that record's id as `existingRecordId`. The press then only ever updates
   * that record: when the cache no longer holds it (it was deleted, or it was
   * deleted and created again under a new id), the press is refused with a
   * reason and writes nothing, so it can never create a server.
   */
  readonly apply: (target: McpServerSwitchTarget, on: boolean, existingRecordId?: string) => void;
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
  const pressedAgainst = new Map<string, string | null>();
  guard.subscribe(() => {
    for (const key of pressedAgainst.keys()) {
      const { refusal, blocked } = guard.readState(key);
      if (refusal === null && !blocked) pressedAgainst.delete(key);
    }
  });
  const stateWithoutRefusal = new WeakMap<McpListEditState, McpListEditState>();

  /**
   * Runs the write, then reads the list of servers again, on its own
   * (`readBaseAfterWrite`), and releases the target when that read succeeded.
   * The cache still lacks the change until then, and a press built on it would
   * undo it. The server's page is marked stale and read again if somebody
   * shows it, without holding the target.
   */
  const run = async (
    key: string,
    record: McpServer | undefined,
    write: () => Promise<unknown>,
  ): Promise<void> => {
    let saved = false;
    let failure: unknown = undefined;
    try {
      await write();
      saved = true;
    } catch (error) {
      failure = error;
    }
    if (record !== undefined) {
      void queryClient.invalidateQueries({ queryKey: cache.readPageKey(record.id), exact: true });
    }
    // A refusal can mean the cache was out of date, such as the `conflict` of a second server for one Connection.
    const read = await readBaseAfterWrite(queryClient, cache.readCatalogue());
    const wasRead = read.hasSucceeded();
    if (wasRead) read.stop();
    guard.finish(key, {
      refusal: saved ? null : { kind: "refused", message: readErrorMessage(failure) },
      unread: wasRead ? null : { saved, read },
    });
  };

  return {
    apply: (target, on, existingRecordId) => {
      const key = buildTargetKey(target);
      if (guard.isBlocked(key)) return;
      const servers = cache.readServers();
      const record = servers === undefined ? undefined : findRecord(servers, target);
      /** Records what the press was made against, just before it leaves a refusal or starts a write. */
      const refuse = (message: string): void => {
        pressedAgainst.set(key, record?.id ?? null);
        guard.refuse(key, { kind: "refused", message });
      };
      if (servers === undefined) {
        refuse("The servers are not read yet, so nothing was changed. Try again.");
        return;
      }
      let write: () => Promise<unknown>;
      if (existingRecordId !== undefined && record?.id !== existingRecordId) {
        refuse("This server no longer exists, so nothing was changed.");
        return;
      } else if (record !== undefined) {
        write = () =>
          client.mcpServer.update({ params: { id: record.id }, payload: { enabled: on } });
      } else if (target.kind === "url") {
        refuse("This server no longer exists, so nothing was changed.");
        return;
      } else if (!on) {
        // A server that was never switched on has nothing to switch off.
        return;
      } else {
        const { contributionId, connectionId } = target;
        write = () =>
          client.mcpServer.create({
            payload: { source: { kind: "plugin", contributionId, connectionId } },
          });
      }
      pressedAgainst.set(key, record?.id ?? null);
      guard.start(key);
      void run(key, record, write);
    },
    readState: (target) => {
      const key = buildTargetKey(target);
      const state = guard.readState(key);
      if (state.refusal === null) return state;
      // A refusal describes the row as it was pressed. Once the cache shows another record for the
      // target, such as a server that another client created, the refusal no longer describes it.
      const now = findRecord(cache.readServers() ?? [], target)?.id ?? null;
      if (pressedAgainst.get(key) === now) return state;
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
