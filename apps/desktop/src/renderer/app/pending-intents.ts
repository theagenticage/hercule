/**
 * The pending intents: what the user decided and the app holds back for the
 * undo line before it sends. Three kinds share the store:
 *
 * - `answer`: the answers to a question a Thread asked, sent with
 *   `session.respondToQuestion`;
 * - `merge`: one Task merged into another, sent with `task.merge`;
 * - `signal-answer`: an answer to a signal that acts on its source (a plugin
 *   action, perhaps with a typed reply), sent with `signal.act`.
 *
 * An intent is `pending` for its window, during which Undo cancels it: 8
 * seconds for a `signal-answer`, which cannot be taken back once the source
 * has it, and `UNDO_WINDOW_MS` for the others. While the undo line that shows
 * the intent is under the pointer or holds the focus, a `pending` intent whose
 * window has run out waits (`setHeld`). Then it is `sending`, and then it either succeeds, which removes it, or
 * fails, which keeps it as `failed` with its content and the error's message,
 * so the user can send it again or discard it.
 *
 * The store is held by the account scope (`account-scope.ts`), outside every
 * component, so changing route
 * or closing a pane does nothing to an intent. Every change writes the
 * unfinished intents to storage under a key made of the controller and the
 * signed-in user. A new store with the same key finds them again as `failed`
 * and never sends them by itself: the app may have quit while one was
 * `sending`, so sending it again could send it twice. An intent that was
 * only `pending` was never sent, and its failure says so. Another controller or
 * user has another key and sees nothing.
 *
 * There is no queue for being offline. A send that cannot reach the
 * controller is a failed intent.
 */
import { isRequestClosed, readErrorMessage } from "@hercule/client-core";
import { SIGNAL_ANSWER_HOLD_MS } from "@hercule/client-core/inbox";
import type { FailureReason } from "@hercule/client-core/work";
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
    }
  | {
      readonly kind: "signal-answer";
      readonly signalId: string;
      /** The External Entity the signal is about, whose detail the answer changes. */
      readonly entityId: string;
      /** The action the user took, which the source runs. */
      readonly actionId: string;
      /** The typed reply, when the action has a field. */
      readonly text?: string;
      /** The name of the source, such as "GitHub", for the words about the answer after a restart. */
      readonly sourceName: string;
    };

export interface IntentFailure {
  /** Why the intent was not sent. `@hercule/client-core/work` explains each reason and words it. */
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

/** What `PendingIntents.watch` reports about one intent. */
export type IntentProgress = "sending" | "sent" | "failed" | "cancelled";

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
   * Tells `listener` each time the intent `intentId` starts `sending`, ends
   * `failed`, is `cancelled` by Undo, or is `sent`. The last two are reported
   * before the intent leaves the store, because the intent's removal alone
   * cannot tell sent from cancelled. Returns a function that stops the
   * reports. Nothing is reported after `dispose`.
   */
  readonly watch: (intentId: string, listener: (progress: IntentProgress) => void) => () => void;
  /**
   * Makes a `pending` intent whose window has run out wait while `isHeld` is
   * true, and sends it at once when `isHeld` becomes false and it is overdue.
   * Holding does not lengthen the window: an intent released before its
   * window ran out is sent when the window ends. Does nothing for an intent
   * that is not `pending`.
   */
  readonly setHeld: (intentId: string, isHeld: boolean) => void;
  /**
   * Cancels the intent and removes it. Works only while it is `pending`:
   * returns false for a `sending` or `failed` intent, or an unknown id, and
   * changes nothing.
   */
  readonly undo: (intentId: string) => boolean;
  /**
   * Sends a `failed` intent again at once, with no undo window. Resolves
   * when the send ended, and never rejects: a failure becomes the intent's
   * `failure`. Does nothing for an intent that is not `failed`, and
   * after `dispose`.
   */
  readonly retry: (intentId: string) => Promise<void>;
  /** Removes a `failed` intent. Does nothing for any other state. */
  readonly discard: (intentId: string) => void;
  /**
   * Shows the failed answers of the Task `fromTaskId` on the Task `toTaskId`,
   * as when the first was merged into the second. Only the Task they show on
   * changes: a retry still goes to the Thread and the Request they were
   * given for. Does nothing when there is none.
   */
  readonly moveFailedAnswers: (fromTaskId: string, toTaskId: string) => void;
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

/** Returns the storage key for the intents of the user `username` on `controllerUrl`. */
export const buildPendingIntentsKey = (controllerUrl: string, username: string): string =>
  `pending-intents:${controllerUrl}:${username}`;

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

/** An answer intent: `kind` is narrowed, so its question and answers can be read. */
export type AnswerIntent = PendingIntent & { readonly kind: "answer" };

/** A merge intent: `kind` is narrowed, so its two Tasks can be read. */
export type MergeIntent = PendingIntent & { readonly kind: "merge" };

/** A failed intent: `failure` is set, which the type of every other state does not promise. */
type FailedIntent = { readonly failure: IntentFailure };

/**
 * Returns the answer intents that are `pending` or `sending`. The board draws
 * each one's question as answered while it is held, and draws the question
 * again if the answer fails.
 */
export const listHeldAnswers = (intents: readonly PendingIntent[]): readonly AnswerIntent[] =>
  intents.filter(
    (intent): intent is AnswerIntent => intent.kind === "answer" && intent.state !== "failed",
  );

/**
 * Returns the merge intents that are `pending` or `sending`. The board hides
 * the card of each one's `taskId` while it is held, and shows it again if the
 * merge fails.
 */
export const listHeldMerges = (intents: readonly PendingIntent[]): readonly MergeIntent[] =>
  intents.filter(
    (intent): intent is MergeIntent => intent.kind === "merge" && intent.state !== "failed",
  );

/** Returns the merge intents that failed, oldest first. */
export const listFailedMerges = (
  intents: readonly PendingIntent[],
): readonly (MergeIntent & FailedIntent)[] =>
  intents.filter(
    (intent): intent is MergeIntent & FailedIntent =>
      intent.kind === "merge" && intent.state === "failed",
  );

/**
 * Returns the answer intents that failed, oldest first, whatever Task they
 * show on.
 */
export const listFailedAnswers = (
  intents: readonly PendingIntent[],
): readonly (AnswerIntent & FailedIntent)[] =>
  intents.filter(
    (intent): intent is AnswerIntent & FailedIntent =>
      intent.kind === "answer" && intent.state === "failed",
  );

/**
 * Returns the answer intents of the Task `taskId` that failed, oldest first.
 * The pane shows each one with its words and what the user can do about it.
 */
export const listUnsentAnswers = (
  intents: readonly PendingIntent[],
  taskId: string,
): readonly (AnswerIntent & FailedIntent)[] =>
  listFailedAnswers(intents).filter((intent) => intent.taskId === taskId);

/**
 * Returns why sending `intent` failed with `error`. Only an answer can find
 * its Request closed. Closed at the first send means the controller took
 * nothing; closed at a send again means the first send may have been taken
 * before the Request closed.
 */
const decideFailureReason = (
  intent: PendingIntent,
  error: unknown,
  isRetry: boolean,
): FailureReason => {
  if (intent.kind !== "answer" || !isRequestClosed(error)) return "send-failed";
  return isRetry ? "no-longer-open" : "closed-before-sent";
};

const NOT_SENT: IntentFailure = {
  reason: "interrupted",
  message: "The app closed before this was sent.",
};

const MAYBE_SENT: IntentFailure = {
  reason: "interrupted-while-sending",
  message: "The app closed while this was being sent. It may have been sent.",
};

/**
 * Reads the intents stored under `key`. Returns none when nothing is stored
 * or the text cannot be read. An intent that was `pending` or `sending` comes
 * back `failed`: as `interrupted` (not sent) when it was `pending`, and as
 * `interrupted-while-sending` (it may have been sent) when it was `sending`.
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
          failure: intent.state === "pending" ? NOT_SENT : MAYBE_SENT,
        },
  );
};

const isStoredIntent = (value: unknown): value is PendingIntent => {
  if (typeof value !== "object" || value === null) return false;
  const intent = value as Record<string, unknown>;
  const hasStrings = (...fields: string[]): boolean =>
    fields.every((field) => typeof intent[field] === "string");
  if (!hasStrings("intentId")) return false;
  if (intent.state !== "pending" && intent.state !== "sending" && intent.state !== "failed")
    return false;
  if (intent.kind === "signal-answer") {
    return (
      hasStrings("signalId", "entityId", "actionId", "sourceName") &&
      (intent.text === undefined || typeof intent.text === "string")
    );
  }
  if (!hasStrings("taskId")) return false;
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
  const watchers = new Map<string, Set<(progress: IntentProgress) => void>>();
  // Intents the undo line holds, and the held intents whose window ran out
  // while it did: those are sent the moment the line lets go.
  const heldByLine = new Set<string>();
  const overdue = new Set<string>();

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

  const report = (intentId: string, progress: IntentProgress): void => {
    if (isDisposed) return;
    for (const listener of watchers.get(intentId) ?? []) listener(progress);
    if (progress === "sent" || progress === "cancelled") watchers.delete(intentId);
  };
  const forgetHold = (intentId: string): void => {
    heldByLine.delete(intentId);
    overdue.delete(intentId);
  };

  const transmit = async (intent: PendingIntent, isRetry: boolean): Promise<void> => {
    if (isDisposed) return;
    forgetHold(intent.intentId);
    change(intent.intentId, { state: "sending", failure: null });
    report(intent.intentId, "sending");
    try {
      await send(intent);
    } catch (error) {
      change(intent.intentId, {
        state: "failed",
        failure: {
          reason: decideFailureReason(intent, error, isRetry),
          message: readErrorMessage(error),
        },
      });
      report(intent.intentId, "failed");
      return;
    }
    report(intent.intentId, "sent");
    commit(intents.filter((each) => each.intentId !== intent.intentId));
  };

  /** Starts the window of a `pending` intent. At its end the intent is sent, unless the undo line holds it. */
  const startWindow = (intent: PendingIntent): void => {
    timers.set(
      intent.intentId,
      setTimeout(
        () => {
          timers.delete(intent.intentId);
          if (heldByLine.has(intent.intentId)) overdue.add(intent.intentId);
          else void transmit(intent, false);
        },
        intent.kind === "signal-answer" ? SIGNAL_ANSWER_HOLD_MS : UNDO_WINDOW_MS,
      ),
    );
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
      startWindow(intent);
      return intent.intentId;
    },
    watch: (intentId, listener) => {
      const own = watchers.get(intentId) ?? new Set();
      own.add(listener);
      watchers.set(intentId, own);
      return () => {
        own.delete(listener);
      };
    },
    setHeld: (intentId, isHeld) => {
      if (find(intentId)?.state !== "pending") return;
      if (isHeld) {
        heldByLine.add(intentId);
        return;
      }
      heldByLine.delete(intentId);
      const intent = find(intentId);
      if (intent !== undefined && overdue.delete(intentId)) void transmit(intent, false);
    },
    undo: (intentId) => {
      if (find(intentId)?.state !== "pending") return false;
      clearTimeout(timers.get(intentId));
      timers.delete(intentId);
      forgetHold(intentId);
      report(intentId, "cancelled");
      commit(intents.filter((intent) => intent.intentId !== intentId));
      return true;
    },
    retry: async (intentId) => {
      const intent = find(intentId);
      if (intent?.state === "failed") await transmit(intent, true);
    },
    discard: (intentId) => {
      if (find(intentId)?.state !== "failed") return;
      watchers.delete(intentId);
      commit(intents.filter((intent) => intent.intentId !== intentId));
    },
    moveFailedAnswers: (fromTaskId, toTaskId) => {
      const moved = listUnsentAnswers(intents, fromTaskId).map((intent) => intent.intentId);
      if (moved.length === 0) return;
      commit(
        intents.map((intent) =>
          moved.includes(intent.intentId) ? { ...intent, taskId: toTaskId } : intent,
        ),
      );
    },
    dispose: () => {
      isDisposed = true;
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
      heldByLine.clear();
      overdue.clear();
      watchers.clear();
    },
  };
};
