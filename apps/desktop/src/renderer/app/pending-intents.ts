/**
 * The pending intents: what the user decided and the app holds back for the
 * undo line before it sends. Two kinds share the store:
 *
 * - `answer`: the answers to a question a Thread asked, sent with
 *   `session.respondToQuestion`;
 * - `merge`: one Task merged into another, sent with `task.merge`.
 *
 * An intent is `pending` for `UNDO_WINDOW_MS`, during which Undo cancels it.
 * Then it is `sending`, and then it either succeeds, which removes it, or
 * fails, which keeps it as `failed` with its content and the error's message,
 * so the user can send it again or discard it.
 *
 * The store is held by the shell, outside every component, so changing route
 * or closing a pane does nothing to an intent. Every change writes the
 * unfinished intents to storage under a key made of the controller and the
 * signed-in user. A new store with the same key finds them again as `failed`
 * and never sends them by itself: the app may have quit while one was
 * `sending`, so sending it again could send it twice. Another controller or
 * user has another key and sees nothing.
 *
 * There is no queue for being offline. A send that cannot reach the
 * controller is a failed intent.
 */
import { isRequestClosed, readErrorMessage } from "@hercule/client-core";
import type { SessionRespondToQuestionInput } from "@hercule/contract";

/** How long an intent stays `pending`, where Undo can still cancel it. */
export const UNDO_WINDOW_MS = 5_000;

/** What the user decided, without the progress of sending it. */
export type IntentContent =
  | {
      readonly kind: "answer";
      /** The Task whose card showed the question. */
      readonly taskId: string;
      readonly sessionId: string;
      readonly requestId: string;
      /** The answers as they were at the pick. Later picks do not change them. */
      readonly answers: SessionRespondToQuestionInput["answers"];
    }
  | {
      readonly kind: "merge";
      /** The Task that merges away. */
      readonly taskId: string;
      /** The Task that stays. */
      readonly intoTaskId: string;
    };

/**
 * Why an intent failed:
 *
 * - `send-failed`: the controller refused it, or could not be reached;
 * - `no-longer-open`: sending an answer again was refused because the
 *   Request is closed (the harness moved on, the session exited or is gone).
 *   The first send may have reached it, so the answer may have been taken,
 *   and the app does not send it anywhere else. A refusal for another
 *   reason, such as the runner being away, is `send-failed`: the question is
 *   still open, so Send again stays useful;
 * - `interrupted`: the app quit while the intent was held or being sent.
 */
export type FailureReason = "send-failed" | "no-longer-open" | "interrupted";

export interface IntentFailure {
  readonly reason: FailureReason;
  /** The error's message, or for `interrupted` a note saying the app quit. */
  readonly message: string;
}

/** One held intent. `failure` is set exactly when `state` is `failed`. */
export type PendingIntent = IntentContent & {
  /** Identifies the intent among the others, also across restarts. */
  readonly intentId: string;
  readonly state: "pending" | "sending" | "failed";
  readonly failure: IntentFailure | null;
};

export interface PendingIntents {
  /**
   * Returns the held intents, oldest first. The same array comes back until
   * the next change, as React's `useSyncExternalStore` requires.
   */
  readonly getSnapshot: () => readonly PendingIntent[];
  /** Calls `listener` after every change, until the returned function is called. */
  readonly subscribe: (listener: () => void) => () => void;
  /**
   * Holds a copy of `content` for the undo line, then sends it. Returns the
   * new intent's id. After `dispose` it holds and sends nothing.
   */
  readonly hold: (content: IntentContent) => string;
  /**
   * Cancels the intent and removes it. Works only while it is `pending`:
   * returns false for a `sending` or `failed` intent, or an unknown id, and
   * changes nothing.
   */
  readonly undo: (intentId: string) => boolean;
  /**
   * Sends a `failed` intent again at once, with no undo window. Resolves
   * when the send ended, and never rejects: a failure becomes the intent's
   * `failure`. Does nothing for an intent that is not `failed`, and after
   * `dispose`.
   */
  readonly retry: (intentId: string) => Promise<void>;
  /** Removes a `failed` intent. Does nothing for any other state. */
  readonly discard: (intentId: string) => void;
  /**
   * Stops the timers and makes the store ignore every later change and call:
   * nothing is sent or scheduled, and a send that ends afterwards writes
   * nothing to storage. Call it when the
   * controller or the user changes, so a late answer never reaches the
   * storage of the next store.
   */
  readonly dispose: () => void;
}

/** The part of `Storage` the store uses. */
export type IntentStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/** Returns the storage key for the intents of `userId` on `controllerUrl`. */
export const buildPendingIntentsKey = (controllerUrl: string, userId: string): string =>
  `pending-intents:${controllerUrl}:${userId}`;

/**
 * Returns the answer intent that is `pending` or `sending` for the Request
 * `requestId` of the session `sessionId`, if any. The card draws the question
 * as answered while there is one. A question is found by session and Request,
 * not by Task, because another question may become the card's first during
 * the undo line.
 */
export const findHeldAnswer = (
  intents: readonly PendingIntent[],
  sessionId: string,
  requestId: string,
): PendingIntent | undefined =>
  intents.find(
    (intent) =>
      intent.kind === "answer" &&
      intent.state !== "failed" &&
      intent.sessionId === sessionId &&
      intent.requestId === requestId,
  );

/**
 * Returns the merge intents that are `pending` or `sending`. The board hides
 * the card of each one's `taskId` while it is held, and shows it again if the
 * merge fails.
 */
export const listHeldMerges = (intents: readonly PendingIntent[]): readonly PendingIntent[] =>
  intents.filter((intent) => intent.kind === "merge" && intent.state !== "failed");

/**
 * Returns the answer intents of the Task `taskId` that failed, oldest first.
 * The pane shows each one with its words and what the user can do about it.
 */
export const listUnsentAnswers = (
  intents: readonly PendingIntent[],
  taskId: string,
): readonly (PendingIntent & { readonly kind: "answer"; readonly failure: IntentFailure })[] =>
  intents.filter(
    (
      intent,
    ): intent is PendingIntent & { readonly kind: "answer"; readonly failure: IntentFailure } =>
      intent.kind === "answer" && intent.state === "failed" && intent.taskId === taskId,
  );

const INTERRUPTED: IntentFailure = {
  reason: "interrupted",
  message: "The app closed before this was sent.",
};

/**
 * Reads the intents stored under `key`. Returns none when nothing is stored
 * or the text cannot be read. An intent that was `pending` or `sending` comes
 * back `failed` as `interrupted`.
 */
const loadIntents = (storage: IntentStorage, key: string): readonly PendingIntent[] => {
  let stored: unknown;
  try {
    stored = JSON.parse(storage.getItem(key) ?? "[]");
  } catch {
    return [];
  }
  if (!Array.isArray(stored)) return [];
  return stored.filter(isStoredIntent).map((intent) =>
    intent.state === "failed"
      ? intent
      : {
          ...intent,
          state: "failed",
          failure: INTERRUPTED,
        },
  );
};

const isStoredIntent = (value: unknown): value is PendingIntent => {
  if (typeof value !== "object" || value === null) return false;
  const intent = value as Record<string, unknown>;
  const hasStrings = (...fields: string[]): boolean =>
    fields.every((field) => typeof intent[field] === "string");
  if (!hasStrings("intentId", "taskId")) return false;
  if (intent.state !== "pending" && intent.state !== "sending" && intent.state !== "failed")
    return false;
  if (intent.kind === "merge") return hasStrings("intoTaskId");
  return (
    intent.kind === "answer" &&
    hasStrings("sessionId", "requestId") &&
    typeof intent.answers === "object" &&
    intent.answers !== null
  );
};

/**
 * Creates the store of one controller and one user. The `storage` and
 * `storageKey` hold the unfinished intents between runs (see
 * `buildPendingIntentsKey`). `send` performs the operation of an intent and
 * rejects when the controller refuses it or cannot be reached.
 *
 * When `send` resolves, the intent leaves the store at once. So `send`
 * should resolve only after it has refreshed what the intent changed (the
 * board, the Thread's open questions), or the card flickers back between
 * the intent leaving and the refresh arriving.
 */
export const createPendingIntents = (options: {
  readonly storage: IntentStorage;
  readonly storageKey: string;
  readonly send: (intent: IntentContent) => Promise<unknown>;
}): PendingIntents => {
  const { storage, storageKey, send } = options;
  let intents = loadIntents(storage, storageKey);
  let isDisposed = false;
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const listeners = new Set<() => void>();

  // The in-memory list is the truth and storage is a best-effort copy for
  // the next start. A write that fails (the quota is full) is logged and never
  // stops a hold or a send, because an intent without its timer would be
  // stranded. The cost is that a quit before the next successful write loses
  // the intent.
  //
  // After `dispose` a change is ignored: a send that ends late must not write
  // to the storage a newer store with the same key now owns.
  const commit = (next: readonly PendingIntent[]): void => {
    if (isDisposed) return;
    intents = next;
    try {
      if (next.length === 0) storage.removeItem(storageKey);
      else storage.setItem(storageKey, JSON.stringify(next));
    } catch (error) {
      console.error("Could not save the held intents:", error);
    }
    for (const listener of listeners) listener();
  };
  const find = (intentId: string): PendingIntent | undefined =>
    intents.find((intent) => intent.intentId === intentId);
  const change = (intentId: string, fields: Partial<PendingIntent>): void => {
    commit(
      intents.map((intent) =>
        intent.intentId === intentId ? ({ ...intent, ...fields } as PendingIntent) : intent,
      ),
    );
  };

  const transmit = async (intent: PendingIntent, isRetry: boolean): Promise<void> => {
    if (isDisposed) return;
    change(intent.intentId, { state: "sending", failure: null });
    try {
      await send(intent);
    } catch (error) {
      const isClosed = isRetry && intent.kind === "answer" && isRequestClosed(error);
      change(intent.intentId, {
        state: "failed",
        failure: {
          reason: isClosed ? "no-longer-open" : "send-failed",
          message: readErrorMessage(error),
        },
      });
      return;
    }
    commit(intents.filter((each) => each.intentId !== intent.intentId));
  };

  return {
    getSnapshot: () => intents,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    hold: (content) => {
      // Copied deeply, so the caller changing its `answers` during the undo
      // window does not change what is sent.
      const intent: PendingIntent = {
        ...structuredClone(content),
        intentId: crypto.randomUUID(),
        state: "pending",
        failure: null,
      };
      if (isDisposed) return intent.intentId;
      commit([...intents, intent]);
      timers.set(
        intent.intentId,
        setTimeout(() => {
          timers.delete(intent.intentId);
          void transmit(intent, false);
        }, UNDO_WINDOW_MS),
      );
      return intent.intentId;
    },
    undo: (intentId) => {
      if (find(intentId)?.state !== "pending") return false;
      clearTimeout(timers.get(intentId));
      timers.delete(intentId);
      commit(intents.filter((intent) => intent.intentId !== intentId));
      return true;
    },
    retry: async (intentId) => {
      const intent = find(intentId);
      if (intent?.state === "failed") await transmit(intent, true);
    },
    discard: (intentId) => {
      if (find(intentId)?.state === "failed")
        commit(intents.filter((intent) => intent.intentId !== intentId));
    },
    dispose: () => {
      isDisposed = true;
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    },
  };
};

/**
 * The place where the window keeps the store of the signed-in user. A store
 * belongs to one controller and one user, but the user is known only after
 * the shell has read it, so the store is opened then.
 */
export interface PendingIntentsHolder {
  /**
   * Returns the store of `userId`, creating it on first use. Asking again for
   * the same user returns the same store. Asking for another user disposes
   * the first user's store, so an intent never reaches the next user.
   */
  readonly open: (
    userId: string,
    send: (intent: IntentContent) => Promise<unknown>,
  ) => PendingIntents;
  /**
   * Disposes the open store, as sign-out does. What it still held stays in
   * storage and comes back as unsent when the user opens a store again.
   */
  readonly close: () => void;
}

/** Creates the holder for the controller at `controllerUrl`, keeping intents in `storage`. */
export const createPendingIntentsHolder = (
  controllerUrl: string,
  storage: IntentStorage,
): PendingIntentsHolder => {
  let current: { readonly userId: string; readonly store: PendingIntents } | null = null;
  return {
    open: (userId, send) => {
      if (current?.userId === userId) return current.store;
      current?.store.dispose();
      const store = createPendingIntents({
        storage,
        storageKey: buildPendingIntentsKey(controllerUrl, userId),
        send,
      });
      current = { userId, store };
      return store;
    },
    close: () => {
      current?.store.dispose();
      current = null;
    },
  };
};
