/**
 * Edits of the three lists of MCP Servers a user changes: a started Thread's
 * list, a project's list, and the default list of Threads without a project.
 *
 * One module owns every edit, whichever screen the user makes it on, so the
 * rules hold in one place:
 *
 * - One edit per list runs at a time. The guard is taken when the edit is
 *   applied and kept until the list was read again, so a second edit never
 *   starts from a list the first one replaced. It lives here, not in a menu
 *   or a dialog, so closing and opening one does not release it.
 * - A choice is resolved against the list and the servers the cache holds when
 *   the edit runs, never against what a control drew a while ago.
 * - A write's response is never put in the cache. The list is read again
 *   after every write, and only that read fills the cache, so a late response
 *   cannot put back what a newer read removed.
 *
 * The module has no React in it. An app passes its cache's shapes in an
 * `McpListCache` and subscribes its controls to `readState`.
 */
import type { FetchQueryOptions, QueryClient, QueryKey } from "@tanstack/query-core";
import type { McpServer } from "@hercule/contract";
import type { HerculeClient } from "../client";
import { ApiError, readErrorMessage } from "../errors";
import { createEditGuard, type McpListEditState, type McpListRefusal } from "./edit-guard";
import { chooseNamedServer, findOtherOccupant, type NamedServer } from "./named-lists";
import { decideProjectBoxWrite, type ProjectBoxAction } from "./project-boxes";
import {
  markQueriesStale,
  readBaseAfterWrite,
  readCatalogueAfterRefusal,
  type McpListQuery,
} from "./reconcile";
import {
  canResetToStart,
  decideThreadStartSource,
  type StartProjectRecord,
  type StartRecord,
  type ThreadStartList,
} from "./start-list";
import { buildMcpServerViews, type McpServerView } from "./views";

export type { McpListQuery } from "./reconcile";

/**
 * Returns the `McpListQuery` of the query `options`: reading it fetches with
 * the query's own options, such as its retries, and with `staleTime` 0, so the
 * answer comes from the controller.
 */
export const buildMcpListQuery = <Data, Failure, Selected, Key extends QueryKey>(
  queryClient: QueryClient,
  options: FetchQueryOptions<Data, Failure, Selected, Key>,
): McpListQuery => ({
  queryKey: options.queryKey,
  fetch: () => queryClient.fetchQuery({ ...options, staleTime: 0 }),
});

/** The list an edit changes. */
export type McpListTarget =
  /** The list of a started Thread, `projectId` being the project it is in (`null` for none), which decides the list it started from. */
  | { readonly kind: "thread"; readonly sessionId: string; readonly projectId: string | null }
  | { readonly kind: "project"; readonly projectId: string }
  /** The list of Threads without a project, the setting `thread.mcpServerIds`. */
  | { readonly kind: "default" };

/** What the user did. The module resolves it against the list when the edit runs. */
export type McpListChoice =
  /**
   * Switches the server named `name` on with the account `serverId`, off with
   * `null`, or swaps its account. `shownServerId` is the account the control
   * showed for the name, which a swap or an off replaces. The edit is refused
   * as `taken` when the list names another account of that name by then.
   */
  | {
      readonly kind: "name";
      readonly name: string;
      readonly serverId: string | null;
      readonly shownServerId: string;
    }
  /** A press on a box of a server's page (spec 17, Settings > MCP servers). */
  | { readonly kind: "box"; readonly serverId: string; readonly action: ProjectBoxAction }
  /** Goes back to the list a started Thread started from. */
  | { readonly kind: "reset" };

/**
 * How an app's cache holds what an edit reads. The module decides everything
 * else.
 */
export interface McpListCache {
  /** Returns the ids the target's list holds in the cache now, or `undefined` while the list is not cached or its project is gone. */
  readList(target: McpListTarget): readonly string[] | undefined;
  /**
   * Returns the query that holds the record a next edit of the target is made
   * from: the Thread's session, the list of projects, the settings. The module
   * reads it again after a write and keeps the target blocked until that read
   * succeeds.
   */
  readBase(target: McpListTarget): McpListQuery;
  /** Returns the other queries that hold the target's list, such as a project read by its id. After a write they are marked stale and not read: the next use reads them. */
  readOtherKeys(target: McpListTarget): readonly QueryKey[];
  /** Returns the server records the cache holds, or `undefined` while the list of servers is not cached. Every decision of an edit is made from their ids and names. */
  readServers(): readonly McpServer[] | undefined;
  /**
   * Returns the servers joined with their Connections as the cache holds them,
   * or `undefined` while one of the reads is missing. Only the words of a
   * refusal use it, to name the server that holds a name, so an edit never
   * waits for it.
   */
  readViews(): readonly McpServerView[] | undefined;
  /** Returns the query that reads the servers. A refusal as invalid reads it again, because the list may name a deleted server. */
  readCatalogue(): McpListQuery;
  /** Returns the records a Thread's start list is decided from, for the project `projectId`. */
  readStartRecords(projectId: string | null): {
    readonly project: StartProjectRecord;
    readonly defaultIds: StartRecord<readonly string[]>;
  };
}

/** The edits of MCP lists. */
export interface McpListEdits {
  /**
   * Applies `choice` to the target's list and writes the result. Does nothing
   * while the target is blocked, and when the choice changes nothing. The
   * guard is taken before this returns, so a second call in the same tick
   * does nothing.
   */
  readonly apply: (target: McpListTarget, choice: McpListChoice) => void;
  /** Returns what a control shows of the target. */
  readonly readState: (target: McpListTarget) => McpListEditState;
  /** Forgets the target's refusal, when the user dismisses it. */
  readonly clearRefusal: (target: McpListTarget) => void;
  /**
   * Counts the caller as a control that shows the target's state, such as a
   * menu or a screen that stays mounted. A refusal stays while one does. After
   * the last one has left, a refusal is dropped after
   * `DETACHED_REFUSAL_LIFETIME_MS`. Returns the function that detaches.
   */
  readonly attach: (target: McpListTarget) => () => void;
  /** Calls `listener` whenever the state of any target changes. Returns the function that stops it. */
  readonly subscribe: (listener: () => void) => () => void;
}

/** What the module decided about a choice. */
export type McpListDecision =
  | { readonly kind: "write"; readonly mcpServerIds: readonly string[] }
  | { readonly kind: "unchanged" }
  /** The list names `occupantId`, another server of the name, and not the one the user saw. `serverId` is the server the user asked for. */
  | { readonly kind: "taken"; readonly occupantId: string; readonly serverId: string };

const isSameList = (one: readonly string[], other: readonly string[]): boolean =>
  one.length === other.length && one.every((id, index) => id === other[index]);

/**
 * Returns what `choice` does to the list `ids`, given the ids and names of the
 * `servers` the catalogue knows. Pure, so a Draft Thread, which keeps its list
 * as an unsent pick, decides a choice the same way a started Thread does.
 *
 * - `write`: the new list. Ids that no server knows stay in it, so an edit
 *   never erases a server the catalogue has not read yet.
 * - `unchanged`: nothing to write. A server the catalogue does not know (the
 *   requested one, or for an off the one the user saw), a name that is
 *   already off, a list that would stay the same, and a reset while `start`
 *   is unknown or would not change the list (`canResetToStart`).
 * - `taken`: the name's slot in `ids` holds another server than the one the
 *   user saw, so the choice would replace a server the user never decided
 *   about (`findOtherOccupant`).
 *
 * `start` is the Thread's start list, used by `reset` only.
 */
export const decideMcpListChoice = ({
  ids,
  servers,
  choice,
  start,
}: {
  readonly ids: readonly string[];
  readonly servers: readonly NamedServer[];
  readonly choice: McpListChoice;
  readonly start?: ThreadStartList | undefined;
}): McpListDecision => {
  const decideWrite = (next: readonly string[]): McpListDecision =>
    isSameList(next, ids) ? { kind: "unchanged" } : { kind: "write", mcpServerIds: next };
  switch (choice.kind) {
    case "name": {
      // The account the choice is about: the one asked for, or for an off the one the user saw.
      const requestedId = choice.serverId ?? choice.shownServerId;
      if (!servers.some((server) => server.id === requestedId && server.name === choice.name)) {
        return { kind: "unchanged" };
      }
      const occupantId = findOtherOccupant(ids, servers, choice.name, [
        choice.shownServerId,
        requestedId,
      ]);
      if (occupantId !== undefined) return { kind: "taken", occupantId, serverId: requestedId };
      return decideWrite(chooseNamedServer(ids, servers, choice.name, choice.serverId));
    }
    case "box": {
      const server = servers.find((each) => each.id === choice.serverId);
      if (server === undefined) return { kind: "unchanged" };
      const decided = decideProjectBoxWrite(ids, servers, server, choice.action);
      return decided.kind === "refused"
        ? { kind: "taken", occupantId: decided.occupantId, serverId: choice.serverId }
        : decideWrite(decided.mcpServerIds);
    }
    case "reset":
      return start === undefined || !canResetToStart(start, ids)
        ? { kind: "unchanged" }
        : { kind: "write", mcpServerIds: start.mcpServerIds };
  }
};

/**
 * Returns the words for what a control shows of a target, except a refusal as
 * `taken`, which a box words itself (see `describeProjectRefusal`), or `null`
 * when there is nothing to say. `prefix` goes before the controller's reason.
 */
export const describeMcpListProblem = (state: McpListEditState, prefix = ""): string | null => {
  const refusal = state.refusal;
  const unread =
    state.unread === null
      ? null
      : state.unread.saved
        ? "Saved, but the list could not be read again."
        : "The list could not be read again.";
  if (refusal === null) return unread;
  const reason =
    refusal.kind === "refused"
      ? `${prefix}${refusal.message}`
      : `The list already names ${refusal.occupant.server.name}${
          refusal.occupant.account === undefined ? "" : ` ${refusal.occupant.account}`
        }, so nothing was changed.`;
  return unread === null ? reason : `${reason} ${unread}`;
};

const buildTargetKey = (target: McpListTarget): string =>
  target.kind === "thread"
    ? `thread:${target.sessionId}`
    : target.kind === "project"
      ? `project:${target.projectId}`
      : "default";

const NOT_LOADED: Readonly<Record<McpListTarget["kind"], string>> = {
  thread: "This thread is not loaded, so its list was not changed.",
  project: "This project no longer exists, so its list was not changed.",
  default: "The settings are not loaded, so the default list was not changed.",
};

/**
 * Creates the edits of MCP lists over `queryClient`, writing through `client`
 * and reading the cache's shapes through `cache`. An app uses one instance for
 * its query client (see `findOrCreateMcpListEdits`).
 */
export const createMcpListEdits = ({
  queryClient,
  client,
  cache,
}: {
  readonly queryClient: QueryClient;
  readonly client: HerculeClient;
  readonly cache: McpListCache;
}): McpListEdits => {
  const guard = createEditGuard();

  /** Writes `mcpServerIds` as the list of the target. */
  const write = (target: McpListTarget, mcpServerIds: readonly string[]): Promise<unknown> => {
    switch (target.kind) {
      case "thread":
        return client.session.update({
          params: { id: target.sessionId },
          payload: { mcpServerIds: [...mcpServerIds] },
        });
      case "project":
        return client.project.update({
          params: { id: target.projectId },
          payload: { mcpServerIds: [...mcpServerIds] },
        });
      case "default":
        return client.settings.update({
          payload: { user: { "thread.mcpServerIds": [...mcpServerIds] } },
        });
    }
  };

  /**
   * Runs the write, then reads again what it may have changed, and releases
   * the target when the edit base was read.
   *
   * - The base is read first and on its own (`readBaseAfterWrite`). The
   *   cache then still holds the list as it was before the write, and an edit
   *   built on it would undo the write.
   * - The other queries of the list are only marked stale.
   * - A server deleted since the list was read makes the controller refuse the
   *   list as invalid, so the servers are read again too, after the refusal.
   */
  const run = async (
    key: string,
    target: McpListTarget,
    mcpServerIds: readonly string[],
  ): Promise<void> => {
    let saved = false;
    let failure: unknown = undefined;
    try {
      await write(target, mcpServerIds);
      saved = true;
    } catch (error) {
      failure = error;
    }
    markQueriesStale(queryClient, cache.readOtherKeys(target));
    const catalogue =
      failure instanceof ApiError && failure.code === "validation"
        ? readCatalogueAfterRefusal(queryClient, cache.readCatalogue())
        : undefined;
    const read = await readBaseAfterWrite(queryClient, cache.readBase(target));
    await catalogue;
    // Asked only now: a read that succeeded while the servers were read still counts.
    const wasRead = read.hasSucceeded();
    if (wasRead) read.stop();
    guard.finish(key, {
      refusal: saved ? null : { kind: "refused", message: readErrorMessage(failure) },
      unread: wasRead ? null : { saved, read },
    });
  };

  /** Describes the server `serverId` for the words of a refusal: its joined view when the cache holds one, else its record alone. */
  const describeOccupant = (servers: readonly McpServer[], serverId: string): McpServerView => {
    const joined = cache.readViews()?.find((view) => view.server.id === serverId);
    return (
      joined ?? buildMcpServerViews([servers.find((server) => server.id === serverId)!], [], [])[0]!
    );
  };

  /** Returns the refusal that stops a choice from being applied, or the decision about it. */
  const decide = (
    target: McpListTarget,
    choice: McpListChoice,
  ):
    | Exclude<McpListDecision, { readonly kind: "taken" }>
    | Extract<McpListRefusal, { readonly kind: "taken" }>
    | { readonly kind: "refused"; readonly message: string } => {
    const refused = (message: string) => ({ kind: "refused", message }) as const;
    const ids = cache.readList(target);
    if (ids === undefined) return refused(NOT_LOADED[target.kind]);
    const servers = cache.readServers();
    if (servers === undefined) {
      return refused("The servers are not read yet, so the list was not changed. Try again.");
    }
    if (choice.kind === "box" && !servers.some((server) => server.id === choice.serverId)) {
      return refused(
        "This server is not in the list of servers yet, so the list was not changed. Try again.",
      );
    }
    let decided: McpListDecision;
    if (choice.kind !== "reset") {
      decided = decideMcpListChoice({ ids, servers, choice });
    } else if (target.kind !== "thread") {
      // Only a started Thread has a list to go back to.
      return { kind: "unchanged" };
    } else {
      const source = decideThreadStartSource({
        projectId: target.projectId,
        ...cache.readStartRecords(target.projectId),
        knownServerIds: new Set(servers.map((server) => server.id)),
      });
      switch (source.kind) {
        case "pending":
          return refused("The list this thread started from is not read yet. Try again.");
        case "failed":
          return refused(`Where this list started could not be read (${source.message}).`);
        case "missing":
          return refused(
            "This thread's project no longer exists, so there is no list to go back to.",
          );
        case "start":
          // A list with ids the servers do not know yet would be written without them.
          if (!source.start.complete) {
            return refused(
              "The servers are not fully read yet, so the list cannot be reset. Try again.",
            );
          }
          decided = decideMcpListChoice({ ids, servers, choice, start: source.start });
      }
    }
    return decided.kind === "taken"
      ? {
          kind: "taken",
          occupant: describeOccupant(servers, decided.occupantId),
          serverId: decided.serverId,
        }
      : decided;
  };

  return {
    apply: (target, choice) => {
      const key = buildTargetKey(target);
      if (guard.isBlocked(key)) return;
      const decided = decide(target, choice);
      switch (decided.kind) {
        case "unchanged":
          return;
        case "refused":
          guard.refuse(key, decided);
          return;
        case "taken":
          guard.refuse(key, decided);
          // The cache may be older than the controller's list, which is why another server holds the
          // name. Reading the list again lets the user's next try see what is there.
          for (const queryKey of [
            cache.readBase(target).queryKey,
            ...cache.readOtherKeys(target),
          ]) {
            void queryClient.invalidateQueries({ queryKey, exact: true });
          }
          return;
        case "write": {
          guard.start(key);
          void run(key, target, decided.mcpServerIds);
        }
      }
    },
    readState: (target) => guard.readState(buildTargetKey(target)),
    clearRefusal: (target) => {
      guard.clearRefusal(buildTargetKey(target));
    },
    attach: (target) => guard.attach(buildTargetKey(target)),
    subscribe: guard.subscribe,
  };
};

const sharedEdits = new WeakMap<QueryClient, McpListEdits>();

/**
 * Returns the edits of `queryClient`, creating them with `options` the first
 * time. There is one instance for each query client, so two controls that
 * edit one list, a menu and a dialog, share one guard and one refusal.
 */
export const findOrCreateMcpListEdits = (options: {
  readonly queryClient: QueryClient;
  readonly client: HerculeClient;
  readonly cache: McpListCache;
}): McpListEdits => {
  const found = sharedEdits.get(options.queryClient);
  if (found !== undefined) return found;
  const created = createMcpListEdits(options);
  sharedEdits.set(options.queryClient, created);
  return created;
};
