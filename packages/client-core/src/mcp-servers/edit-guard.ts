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
import type { BaseReadWatch } from "./reconcile";
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

/** What a write that ended leaves on its target. */
export interface WriteOutcome {
  /** Why the write failed, or `null` when it was acknowledged. */
  readonly refusal: McpListRefusal | null;
  /**
   * Set when the edit base could not be read again: the target stays blocked
   * until `read` sees a fetch of it succeed. The guard stops `read` then.
   */
  readonly unread: { readonly saved: boolean; readonly read: BaseReadWatch } | null;
}

/** How long a refusal that no control shows stays, in milliseconds. A control that attaches later still finds it. */
export const DETACHED_REFUSAL_LIFETIME_MS = 5 * 60 * 1000;

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
  /**
   * Counts the caller as a control that shows the target. While at least one
   * does, a refusal stays. When none does, the refusal is dropped after
   * `DETACHED_REFUSAL_LIFETIME_MS`, so state of a control that left cannot
   * pile up. Returns the function that detaches.
   */
  readonly attach: (key: string) => () => void;
  /** Calls `listener` whenever the state of any target changes. Returns the function that stops it. */
  readonly subscribe: (listener: () => void) => () => void;
}

const IDLE: McpListEditState = { blocked: false, refusal: null, unread: null };

/** What the guard keeps of one target while it is not idle. */
interface Held {
  running: boolean;
  refusal: McpListRefusal | null;
  unread: WriteOutcome["unread"];
  /** Drops the refusal when no control shows the target for long enough, or `null` while none is set. */
  expiry: ReturnType<typeof setTimeout> | null;
  snapshot: McpListEditState;
}

/** Creates a guard with no target held. */
export const createEditGuard = (): EditGuard => {
  const held = new Map<string, Held>();
  const attached = new Map<string, number>();
  const listeners = new Set<() => void>();

  const stopExpiry = (each: Held): void => {
    if (each.expiry !== null) clearTimeout(each.expiry);
    each.expiry = null;
  };

  /** Starts or stops the countdown that drops the target's refusal, from whether a control shows it. */
  const syncExpiry = (key: string, each: Held): void => {
    const shown = (attached.get(key) ?? 0) > 0;
    if (each.refusal === null || shown) {
      stopExpiry(each);
    } else if (each.expiry === null) {
      each.expiry = setTimeout(() => {
        each.expiry = null;
        each.refusal = null;
        commit(key);
      }, DETACHED_REFUSAL_LIFETIME_MS);
    }
  };

  /** Rebuilds the target's state after a change, forgets it when it is idle, and tells the listeners. */
  function commit(key: string): void {
    const each = held.get(key);
    if (each !== undefined) {
      syncExpiry(key, each);
      if (!each.running && each.refusal === null && each.unread === null) held.delete(key);
      else {
        each.snapshot = {
          blocked: each.running || each.unread !== null,
          refusal: each.refusal,
          unread: each.unread === null ? null : { saved: each.unread.saved },
        };
      }
    }
    for (const listener of listeners) listener();
  }

  const hold = (key: string): Held => {
    let each = held.get(key);
    if (each === undefined) {
      each = { running: false, refusal: null, unread: null, expiry: null, snapshot: IDLE };
      held.set(key, each);
    }
    return each;
  };

  const setRefusal = (each: Held, refusal: McpListRefusal | null): void => {
    stopExpiry(each);
    each.refusal = refusal;
  };

  return {
    isBlocked: (key) => {
      const each = held.get(key);
      return each !== undefined && (each.running || each.unread !== null);
    },
    start: (key) => {
      const each = hold(key);
      each.running = true;
      setRefusal(each, null);
      commit(key);
    },
    refuse: (key, refusal) => {
      setRefusal(hold(key), refusal);
      commit(key);
    },
    finish: (key, outcome) => {
      const each = hold(key);
      each.running = false;
      setRefusal(each, outcome.refusal);
      if (outcome.unread !== null) {
        const { read } = outcome.unread;
        const unread = outcome.unread;
        each.unread = unread;
        // The first fetch of the edit base that succeeds releases the target, whenever it comes.
        read.whenSucceeded(() => {
          if (each.unread !== unread) return;
          each.unread = null;
          read.stop();
          commit(key);
        });
      }
      commit(key);
    },
    readState: (key) => held.get(key)?.snapshot ?? IDLE,
    clearRefusal: (key) => {
      const each = held.get(key);
      if (each === undefined || each.refusal === null) return;
      setRefusal(each, null);
      commit(key);
    },
    attach: (key) => {
      attached.set(key, (attached.get(key) ?? 0) + 1);
      const each = held.get(key);
      if (each !== undefined) syncExpiry(key, each);
      let attachedNow = true;
      return () => {
        if (!attachedNow) return;
        attachedNow = false;
        const count = (attached.get(key) ?? 1) - 1;
        if (count === 0) attached.delete(key);
        else attached.set(key, count);
        const found = held.get(key);
        if (found !== undefined) syncExpiry(key, found);
      };
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
};
