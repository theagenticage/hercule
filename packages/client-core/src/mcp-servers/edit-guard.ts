/**
 * The guard every write of an MCP list or an MCP server's switch runs under.
 * One guard holds what is true of each target (a Thread's list, a project's
 * list, one server's switch): whether a write runs, why the last one was
 * refused, and whether the cache was not read again after it.
 *
 * The state lives here, not in a control, so closing and opening a menu or a
 * dialog does not release it. The guard has no React in it: a control
 * subscribes to `readState`.
 */
import type { QueryClient, QueryKey } from "@tanstack/query-core";
import type { McpServerView } from "./views";

/** Why a write was not made. */
export type McpListRefusal =
  /** The controller refused the write, or the write could not start: `message` says why. */
  | { readonly kind: "refused"; readonly message: string }
  /** The list names `occupant`, another server of the name, and not the one the user saw. `serverId` is the server the user asked for. */
  | { readonly kind: "taken"; readonly occupant: McpServerView; readonly serverId: string };

/** What is true while the cache could not be read again after a write. */
export interface McpListUnread {
  /** True when the controller acknowledged the write: the change is saved, but the cache lacks it. */
  readonly saved: boolean;
}

/** What a control shows of a target. The object stays the same until the target changes. */
export interface McpListEditState {
  /** True while a write runs, or the cache was not read again after the last one. Controls ignore new writes then. */
  readonly blocked: boolean;
  /** Why the last write was not made. It stays until `clearRefusal` or the next write. */
  readonly refusal: McpListRefusal | null;
  /** Set while the cache could not be read again. A read of it that succeeds releases the target, and dismissing a refusal does not. */
  readonly unread: McpListUnread | null;
}

/** Where a query was when a write ended: a read of it after that releases an unread target. */
export interface ReadMark {
  readonly query: unknown;
  readonly updates: number;
}

/** Returns where the query `queryKey` is now, to compare a later read with. */
export const readMarkOf = (queryClient: QueryClient, queryKey: QueryKey): ReadMark => {
  const query = queryClient.getQueryCache().find({ queryKey, exact: true });
  return { query, updates: query?.state.dataUpdateCount ?? 0 };
};

/** Returns true when the query `queryKey` holds data that a read made after `mark` fetched. */
export const hasReadSince = (
  queryClient: QueryClient,
  queryKey: QueryKey,
  mark: ReadMark,
): boolean => {
  const query = queryClient.getQueryCache().find({ queryKey, exact: true });
  return (
    query?.state.status === "success" &&
    (query !== mark.query || query.state.dataUpdateCount > mark.updates)
  );
};

/** What a write that ended leaves on its target. */
export interface WriteOutcome {
  /** Why the write failed, or `null` when it was acknowledged. */
  readonly refusal: McpListRefusal | null;
  /** Set when the query `baseKey` could not be read again: the target stays blocked until a read of it succeeds after `mark`. */
  readonly unread: {
    readonly saved: boolean;
    readonly baseKey: QueryKey;
    readonly mark: ReadMark;
  } | null;
}

/** The guard of the targets of one query client. */
export interface EditGuard {
  /** Returns true while a write of the target runs, or the cache was not read again after the last one. */
  readonly isBlocked: (key: string) => boolean;
  /** Marks a write of the target as running and drops its refusal. Call it before the first await, so a second call in the same tick sees it. */
  readonly start: (key: string) => void;
  /** Records why a write was not made, without running one. */
  readonly refuse: (key: string, refusal: McpListRefusal) => void;
  /** Marks the write of the target as ended, with what it left. */
  readonly finish: (key: string, outcome: WriteOutcome) => void;
  /** Returns what a control shows of the target. */
  readonly readState: (key: string) => McpListEditState;
  /** Forgets the target's refusal, when the user dismisses it. */
  readonly clearRefusal: (key: string) => void;
  /** Calls `listener` whenever the state of any target changes. Returns the function that stops it. */
  readonly subscribe: (listener: () => void) => () => void;
}

const IDLE: McpListEditState = { blocked: false, refusal: null, unread: null };

/** What the guard keeps of one target while it is not idle. */
interface Held {
  running: boolean;
  refusal: McpListRefusal | null;
  unread: WriteOutcome["unread"];
  snapshot: McpListEditState;
}

/** Creates the guard of the targets of `queryClient`. */
export const createEditGuard = (queryClient: QueryClient): EditGuard => {
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
    // A read of the base that succeeds releases an unread target, so the guard watches the cache only while one exists.
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

  return {
    isBlocked: (key) => {
      const each = held.get(key);
      return each !== undefined && (each.running || each.unread !== null);
    },
    start: (key) => {
      const each = hold(key);
      each.running = true;
      each.refusal = null;
      commit(key);
    },
    refuse: (key, refusal) => {
      hold(key).refusal = refusal;
      commit(key);
    },
    finish: (key, outcome) => {
      const each = hold(key);
      each.running = false;
      each.refusal = outcome.refusal;
      each.unread = outcome.unread;
      commit(key);
    },
    readState: (key) => held.get(key)?.snapshot ?? IDLE,
    clearRefusal: (key) => {
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
