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
import type { HerculeClient } from "../client";
import { ApiError, readErrorMessage } from "../errors";
import { chooseNamedServer } from "./named-lists";
import { decideProjectBoxWrite, type ProjectBoxAction } from "./project-boxes";
import {
  decideThreadStartSource,
  type StartProjectRecord,
  type StartRecord,
  type ThreadStartList,
} from "./start-list";
import type { McpServerView } from "./views";

/** A query the module reads: its key, and a read of it that never answers from the cache. */
export interface McpListQuery {
  readonly queryKey: QueryKey;
  /** Reads the query from the controller and puts the answer in the cache, even when the cache holds a fresh one. */
  readonly fetch: () => Promise<unknown>;
}

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
  /** Returns the other queries that hold the target's list, such as a project read by its id. They are marked stale, not read. */
  readOtherKeys(target: McpListTarget): readonly QueryKey[];
  /** Returns the servers joined with their Connections as the cache holds them, or `undefined` while one of the reads is missing. */
  readViews(): readonly McpServerView[] | undefined;
  /** Returns the query that reads the servers. A refusal as invalid reads it again, because the list may name a deleted server. */
  readCatalogue(): McpListQuery;
  /** Returns the records a Thread's start list is decided from, for the project `projectId`. */
  readStartRecords(projectId: string | null): {
    readonly project: StartProjectRecord;
    readonly defaultIds: StartRecord<readonly string[]>;
  };
}

/** Why an edit was not made. */
export type McpListRefusal =
  /** The controller refused the write, or the edit could not start: `message` says why. */
  | { readonly kind: "refused"; readonly message: string }
  /** The list names `occupant`, another server of the name, and not the one the user saw. `serverId` is the server the user asked for. */
  | { readonly kind: "taken"; readonly occupant: McpServerView; readonly serverId: string };

/** What is true while the list could not be read again after an edit. */
export interface McpListUnread {
  /** True when the controller acknowledged the write: the change is saved, but the cache lacks it. */
  readonly saved: boolean;
}

/** What a control shows of a target. The object stays the same until the target changes. */
export interface McpListEditState {
  /** True while an edit runs, or the list was not read again after the last one. Controls ignore new edits then. */
  readonly blocked: boolean;
  /** Why the last edit was not made. It stays until `clearRefusal` or the next edit. */
  readonly refusal: McpListRefusal | null;
  /** Set while the list could not be read again. A read of it that succeeds releases the target, and dismissing a refusal does not. */
  readonly unread: McpListUnread | null;
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
  /** Calls `listener` whenever the state of any target changes. Returns the function that stops it. */
  readonly subscribe: (listener: () => void) => () => void;
}

/** What the module decided about a choice. */
export type McpListDecision =
  | { readonly kind: "write"; readonly mcpServerIds: readonly string[] }
  | { readonly kind: "unchanged" }
  | { readonly kind: "taken"; readonly occupant: McpServerView; readonly serverId: string };

const isSameList = (one: readonly string[], other: readonly string[]): boolean =>
  one.length === other.length && one.every((id, index) => id === other[index]);

const holdSameIds = (one: readonly string[], other: readonly string[]): boolean =>
  one.length === other.length && one.every((id) => other.includes(id));

/**
 * Returns what `choice` does to the list `ids`, given the servers `views` the
 * catalogue knows. Pure, so a Draft Thread, which keeps its list as an unsent
 * pick, decides a choice the same way a started Thread does.
 *
 * - `write`: the new list. Ids that no server knows stay in it, so an edit
 *   never erases a server the catalogue has not read yet.
 * - `unchanged`: nothing to write. A server the catalogue does not know, an
 *   off whose server is gone or a name that is already off, a list that
 *   would stay the same, and a reset while `start` is unknown or incomplete.
 * - `taken`: the name's slot in `ids` holds another server than the one the
 *   user saw, so the choice would replace a server the user never decided
 *   about.
 *
 * `start` is the Thread's start list, used by `reset` only.
 */
export const decideMcpListChoice = ({
  ids,
  views,
  choice,
  start,
}: {
  readonly ids: readonly string[];
  readonly views: readonly McpServerView[];
  readonly choice: McpListChoice;
  readonly start?: ThreadStartList | undefined;
}): McpListDecision => {
  const decideWrite = (next: readonly string[]): McpListDecision =>
    isSameList(next, ids) ? { kind: "unchanged" } : { kind: "write", mcpServerIds: next };
  switch (choice.kind) {
    case "name": {
      const sameName = views.filter((view) => view.server.name === choice.name);
      const knows = (id: string): boolean => sameName.some((view) => view.server.id === id);
      if (choice.serverId === null && !knows(choice.shownServerId)) return { kind: "unchanged" };
      const occupantId = ids.find((id) => knows(id) && id !== choice.shownServerId);
      if (occupantId !== undefined) {
        return {
          kind: "taken",
          occupant: sameName.find((view) => view.server.id === occupantId)!,
          serverId: choice.serverId ?? choice.shownServerId,
        };
      }
      return decideWrite(chooseNamedServer(ids, views, choice.name, choice.serverId));
    }
    case "box": {
      const server = views.find((view) => view.server.id === choice.serverId);
      if (server === undefined) return { kind: "unchanged" };
      const decided = decideProjectBoxWrite(ids, views, server, choice.action);
      return decided.kind === "refused"
        ? { kind: "taken", occupant: decided.occupant, serverId: choice.serverId }
        : decideWrite(decided.mcpServerIds);
    }
    case "reset":
      return start === undefined || !start.complete || holdSameIds(ids, start.mcpServerIds)
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

const IDLE: McpListEditState = { blocked: false, refusal: null, unread: null };

const buildTargetKey = (target: McpListTarget): string =>
  target.kind === "thread"
    ? `thread:${target.sessionId}`
    : target.kind === "project"
      ? `project:${target.projectId}`
      : "default";

/** Where the base query of a target was when a write ended: a read of it after that releases an unread target. */
interface ReadMark {
  readonly query: unknown;
  readonly updates: number;
}

/** What the module keeps of one target while it is not idle. */
interface Held {
  running: boolean;
  refusal: McpListRefusal | null;
  unread: { readonly saved: boolean; readonly baseKey: QueryKey; readonly mark: ReadMark } | null;
  snapshot: McpListEditState;
}

const readMarkOf = (queryClient: QueryClient, queryKey: QueryKey): ReadMark => {
  const query = queryClient.getQueryCache().find({ queryKey, exact: true });
  return { query, updates: query?.state.dataUpdateCount ?? 0 };
};

/** Returns true when the query `queryKey` holds data that a read made after `mark` fetched. */
const hasReadSince = (queryClient: QueryClient, queryKey: QueryKey, mark: ReadMark): boolean => {
  const query = queryClient.getQueryCache().find({ queryKey, exact: true });
  return (
    query?.state.status === "success" &&
    (query !== mark.query || query.state.dataUpdateCount > mark.updates)
  );
};

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
  const held = new Map<string, Held>();
  const listeners = new Set<() => void>();
  let stopWatching: (() => void) | null = null;

  const releaseReadTargets = (): void => {
    for (const [key, each] of held) {
      if (
        each.unread !== null &&
        hasReadSince(queryClient, each.unread.baseKey, each.unread.mark)
      ) {
        each.unread = null;
        commit(key);
      }
    }
  };

  /** Rebuilds the target's state after a change, forgets it when it is idle, and tells the listeners. */
  function commit(key: string): void {
    const each = held.get(key);
    if (each !== undefined) {
      if (!each.running && each.refusal === null && each.unread === null) held.delete(key);
      else {
        each.snapshot = {
          blocked: each.running || each.unread !== null,
          refusal: each.refusal,
          unread: each.unread === null ? null : { saved: each.unread.saved },
        };
      }
    }
    // A read of the base that succeeds releases an unread target, so the module watches the cache only while one exists.
    const hasUnread = [...held.values()].some((other) => other.unread !== null);
    if (hasUnread && stopWatching === null) {
      stopWatching = queryClient.getQueryCache().subscribe(releaseReadTargets);
    } else if (!hasUnread && stopWatching !== null) {
      stopWatching();
      stopWatching = null;
    }
    for (const listener of listeners) listener();
  }

  const hold = (key: string): Held => {
    let each = held.get(key);
    if (each === undefined) {
      each = { running: false, refusal: null, unread: null, snapshot: IDLE };
      held.set(key, each);
    }
    return each;
  };

  const refuse = (key: string, refusal: McpListRefusal): void => {
    hold(key).refusal = refusal;
    commit(key);
  };

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
   * Reads again what the write may have changed. Returns false when the base
   * record could not be read: the cache then still holds the list as it was
   * before the write, and an edit built on it would undo the write.
   *
   * The base is read with `fetchQuery`, ordered after the write, not
   * invalidated, because an invalidation reads only queries somebody
   * observes. A read already in flight started before the write ended, so it
   * is cancelled first.
   */
  const readAgain = async (
    target: McpListTarget,
    failure: unknown,
  ): Promise<{ readonly ok: boolean; readonly mark: ReadMark }> => {
    const base = cache.readBase(target);
    await queryClient.cancelQueries({ queryKey: base.queryKey, exact: true });
    const mark = readMarkOf(queryClient, base.queryKey);
    const others = cache
      .readOtherKeys(target)
      .map((queryKey) => queryClient.invalidateQueries({ queryKey, exact: true }));
    // A server deleted since the list was read makes the controller refuse the list as invalid.
    const catalogue =
      failure instanceof ApiError && failure.code === "validation"
        ? cache
            .readCatalogue()
            .fetch()
            .catch(() => {})
        : undefined;
    const read = await base.fetch().then(
      () => true,
      // A read of the base that others made meanwhile counts too.
      () => hasReadSince(queryClient, base.queryKey, mark),
    );
    await Promise.all([...others, catalogue]);
    return { ok: read, mark };
  };

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
    const { ok, mark } = await readAgain(target, failure);
    const each = hold(key);
    each.running = false;
    each.refusal = saved ? null : { kind: "refused", message: readErrorMessage(failure) };
    if (!ok) each.unread = { saved, baseKey: cache.readBase(target).queryKey, mark };
    commit(key);
  };

  /** Returns the refusal that stops a choice from being applied, or the decision about it. */
  const decide = (
    target: McpListTarget,
    choice: McpListChoice,
  ): McpListDecision | { readonly kind: "refused"; readonly message: string } => {
    const refused = (message: string) => ({ kind: "refused", message }) as const;
    const ids = cache.readList(target);
    if (ids === undefined) return refused(NOT_LOADED[target.kind]);
    const views = cache.readViews();
    if (views === undefined) {
      return refused("The servers are not read yet, so the list was not changed. Try again.");
    }
    if (choice.kind === "box" && !views.some((view) => view.server.id === choice.serverId)) {
      return refused(
        "This server is not in the list of servers yet, so the list was not changed. Try again.",
      );
    }
    if (choice.kind !== "reset") return decideMcpListChoice({ ids, views, choice });
    // Only a started Thread has a list to go back to.
    if (target.kind !== "thread") return { kind: "unchanged" };
    const source = decideThreadStartSource({
      projectId: target.projectId,
      ...cache.readStartRecords(target.projectId),
      knownServerIds: new Set(views.map((view) => view.server.id)),
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
        return source.start.complete
          ? decideMcpListChoice({ ids, views, choice, start: source.start })
          : refused("The servers are not fully read yet, so the list cannot be reset. Try again.");
    }
  };

  return {
    apply: (target, choice) => {
      const key = buildTargetKey(target);
      const current = held.get(key);
      if (current !== undefined && (current.running || current.unread !== null)) return;
      const decided = decide(target, choice);
      switch (decided.kind) {
        case "unchanged":
          return;
        case "refused":
          refuse(key, decided);
          return;
        case "taken":
          refuse(key, decided);
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
          const each = hold(key);
          each.running = true;
          each.refusal = null;
          commit(key);
          void run(key, target, decided.mcpServerIds);
        }
      }
    },
    readState: (target) => held.get(buildTargetKey(target))?.snapshot ?? IDLE,
    clearRefusal: (target) => {
      const key = buildTargetKey(target);
      const each = held.get(key);
      if (each === undefined || each.refusal === null) return;
      each.refusal = null;
      commit(key);
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
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
