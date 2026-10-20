import { isThreadCopy, type ThreadCopy } from "@hercule/client-core";

/**
 * The thread copies of recently opened threads, kept in IndexedDB so a thread
 * opens from disk instead of from the controller.
 *
 * Every method fails softly. When IndexedDB cannot be opened or used, the
 * failure is logged and the store behaves as if it held no copies, so a thread
 * is then read from the controller as usual. Nothing here runs while a thread
 * streams: the callers use it when a thread opens, when its page closes and
 * when a turn ends.
 */
export interface ThreadCopies {
  /**
   * Returns the thread copy of the thread, or undefined when there is none.
   * A record in another format, or one that no longer fits the contract's
   * schemas, is deleted and also returns undefined. Never fails.
   */
  read(sessionId: string): Promise<ThreadCopy | undefined>;
  /**
   * Returns at once and writes the copy later, when the browser is idle (within
   * about a second), so the write of a large copy does not block the frame
   * that follows a closing page. The write also deletes the copies of the
   * thread's project that were opened longest ago, keeping at most
   * `COPIES_PER_PROJECT`.
   *
   * - A newer save of the same thread replaces a pending one, so only the
   *   newest copy is written.
   * - `delete` and `deleteAll` drop the saves they cover that are still
   *   pending.
   *
   * The returned promise resolves when the write has ended or was dropped. It
   * never fails.
   */
  save(copy: ThreadCopy): Promise<void>;
  /** Drops the pending save of the thread and deletes its copy. Never fails. */
  delete(sessionId: string): Promise<void>;
  /** Drops every pending save and deletes every copy. Never fails. */
  deleteAll(): Promise<void>;
}

/**
 * The version of the record's own shape. A record with another version is
 * deleted when it is read. The schema check on the copy inside the record is
 * separate and catches changes to the contract.
 */
const THREAD_COPY_FORMAT = 1;

/** The version of the database. */
const DATABASE_VERSION = 3;

const DATABASE_NAME = "thread-copies";

/** How many copies one project keeps. Threads with no project count as one project. */
const COPIES_PER_PROJECT = 25;

const THREADS_STORE = "threads";
const META_STORE = "meta";
const PROJECT_INDEX = "byProject";
const CONTROLLER_URL_KEY = "controllerUrl";

/** How long a save may wait for an idle moment before it runs anyway. */
const SAVE_IDLE_TIMEOUT_MS = 1000;

/** Runs `task` when the browser is idle, or after `SAVE_IDLE_TIMEOUT_MS` at the latest. */
const runWhenIdle = (task: () => void): void => {
  requestIdleCallback(task, { timeout: SAVE_IDLE_TIMEOUT_MS });
};

/**
 * One thread copy as stored in `THREADS_STORE`, keyed by `sessionId`.
 * IndexedDB cannot index `null`, so `projectKey` is the project id, or "" for a
 * thread in no project. `lastOpenAt` is the time of the last save of the
 * thread: a copy is saved only while its thread is open, so the oldest
 * `lastOpenAt` is the thread opened longest ago. The index on
 * `[projectKey, lastOpenAt]` lists a project's threads from that one.
 */
interface ThreadCopyRecord {
  readonly format: number;
  readonly sessionId: string;
  readonly projectKey: string;
  readonly lastOpenAt: number;
  readonly copy: ThreadCopy;
}

/**
 * Returns the error an IndexedDB request or transaction failed with. The
 * browser types it as nullable, so when it is null this builds an error that
 * names the failed step `what`.
 */
const buildFailure = (error: DOMException | null, what: string): Error =>
  error ?? new Error(`${what} failed without an error.`);

/** Waits for an IndexedDB request and returns its result. */
const readRequest = <T>(request: IDBRequest<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(buildFailure(request.error, "The IndexedDB request"));
  });

/**
 * Runs `work` in one transaction and returns its result once the transaction
 * has committed. Fails when `work` throws or rejects, or the transaction
 * aborts, for example when the disk quota is exceeded. `work` returns its
 * result directly, or as a promise when it reads. It may only await requests
 * of this transaction, or the transaction ends before its next request.
 */
const runTransaction = async <T>(
  database: IDBDatabase,
  stores: readonly string[],
  mode: IDBTransactionMode,
  work: (transaction: IDBTransaction) => T | Promise<T>,
): Promise<T> => {
  const transaction = database.transaction([...stores], mode);
  const committed = new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(buildFailure(transaction.error, "The transaction"));
    transaction.onabort = () => reject(buildFailure(transaction.error, "The transaction"));
  });
  // `work` runs inside the promise executor so that a synchronous throw
  // becomes a rejection, and `committed` is always awaited.
  const working = new Promise<T>((resolve) => resolve(work(transaction)));
  const [result] = await Promise.all([working, committed]);
  return result;
};

/**
 * Opens the database, creating its stores on first use, and deletes every
 * copy when the saved controller URL is not `controllerUrl`. The copies belong
 * to one controller, and the window reloads with the new URL when the user
 * switches. Comparing here, in one transaction before anyone else reads, also
 * covers a crash between the switch and the delete. Fails when the database
 * cannot be opened.
 */
const openDatabase = async (controllerUrl: string): Promise<IDBDatabase> => {
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = globalThis.indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const upgrading = request.result;
      // Copies are only a cache, so an upgrade drops every old store and
      // starts empty instead of converting.
      for (const name of Array.from(upgrading.objectStoreNames)) upgrading.deleteObjectStore(name);
      const threads = upgrading.createObjectStore(THREADS_STORE, { keyPath: "sessionId" });
      threads.createIndex(PROJECT_INDEX, ["projectKey", "lastOpenAt"]);
      upgrading.createObjectStore(META_STORE);
    };
    // No `onblocked`: an upgrade waits until the other connections close, and
    // they close themselves in `onversionchange` below.
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(buildFailure(request.error, "Opening the database"));
  });
  database.onversionchange = () => database.close();
  try {
    await runTransaction(
      database,
      [THREADS_STORE, META_STORE],
      "readwrite",
      async (transaction) => {
        const meta = transaction.objectStore(META_STORE);
        const savedUrl = await readRequest<unknown>(meta.get(CONTROLLER_URL_KEY));
        if (savedUrl === controllerUrl) return;
        transaction.objectStore(THREADS_STORE).clear();
        meta.put(controllerUrl, CONTROLLER_URL_KEY);
      },
    );
  } catch (error) {
    database.close();
    throw error;
  }
  return database;
};

/** Returns the record's copy when the record has the current format and its copy fits the schemas. */
const readRecordCopy = (record: unknown): ThreadCopy | undefined => {
  if (typeof record !== "object" || record === null) return undefined;
  if (!("format" in record) || record.format !== THREAD_COPY_FORMAT) return undefined;
  if (!("copy" in record)) return undefined;
  return isThreadCopy(record.copy) ? record.copy : undefined;
};

/**
 * Creates the thread copy store for one controller and starts opening its
 * database at once; the database stays open. If a different controller URL
 * was saved before, every copy is deleted as part of that opening, before the
 * first method runs. Opening at once, not on first use, means the copies of
 * the previous controller are gone from disk even if no thread is opened
 * before the user switches back.
 */
export const createThreadCopies = (controllerUrl: string): ThreadCopies => {
  // Never rejects: a failure is logged once, and then every method behaves as
  // if the store were empty.
  const opening: Promise<IDBDatabase | undefined> = openDatabase(controllerUrl).catch(
    (error: unknown) => {
      console.error("Could not open the thread copies:", error);
      return undefined;
    },
  );
  // Saves that wait for an idle moment, one per thread. Replacing an entry's
  // copy keeps its single scheduled write; removing the entry drops the save.
  const pendingSaves = new Map<string, { copy: ThreadCopy; written: Promise<void> }>();

  /** Runs `work` on the database, or returns `fallback` when there is none or `work` fails (logged as `failure`). */
  const runOnDatabase = async <T>(
    failure: string,
    fallback: T,
    work: (database: IDBDatabase) => Promise<T>,
  ): Promise<T> => {
    const database = await opening;
    if (database === undefined) return fallback;
    try {
      return await work(database);
    } catch (error) {
      console.error(failure, error);
      return fallback;
    }
  };

  const deleteRecord = (database: IDBDatabase, sessionId: string): Promise<void> =>
    runTransaction(database, [THREADS_STORE], "readwrite", (transaction) => {
      transaction.objectStore(THREADS_STORE).delete(sessionId);
    });

  /**
   * Writes the copy with the time it was open, and deletes the threads of its
   * project that were opened longest ago, beyond the limit.
   */
  const writeCopy = (copy: ThreadCopy): Promise<void> =>
    runOnDatabase("Could not save the thread copy:", undefined, (database) =>
      runTransaction(database, [THREADS_STORE], "readwrite", async (transaction) => {
        const sessionId = copy.session.id;
        const projectKey = copy.session.projectId ?? "";
        const threads = transaction.objectStore(THREADS_STORE);
        const record: ThreadCopyRecord = {
          format: THREAD_COPY_FORMAT,
          sessionId,
          projectKey,
          lastOpenAt: Date.now(),
          copy,
        };
        threads.put(record);
        // The put above is already counted because requests of one transaction
        // run in order.
        const projectThreads = IDBKeyRange.bound([projectKey, -Infinity], [projectKey, Infinity]);
        const index = threads.index(PROJECT_INDEX);
        const excess = (await readRequest(index.count(projectThreads))) - COPIES_PER_PROJECT;
        if (excess <= 0) return;
        for (const oldSessionId of await readRequest(index.getAllKeys(projectThreads, excess))) {
          threads.delete(oldSessionId);
        }
      }),
    );

  return {
    read: (sessionId) =>
      runOnDatabase("Could not read the thread copy:", undefined, async (database) => {
        const record: unknown = await runTransaction(
          database,
          [THREADS_STORE],
          "readonly",
          (transaction) => readRequest(transaction.objectStore(THREADS_STORE).get(sessionId)),
        );
        if (record === undefined) return undefined;
        const copy = readRecordCopy(record);
        if (copy === undefined) await deleteRecord(database, sessionId);
        return copy;
      }),

    save: (copy) => {
      const sessionId = copy.session.id;
      const pending = pendingSaves.get(sessionId);
      if (pending !== undefined) {
        pending.copy = copy;
        return pending.written;
      }
      const entry = { copy, written: Promise.resolve() };
      entry.written = new Promise<void>((resolve) => {
        runWhenIdle(() => {
          // A delete or a newer entry took this one's place: nothing to write.
          if (pendingSaves.get(sessionId) !== entry) return resolve();
          pendingSaves.delete(sessionId);
          void writeCopy(entry.copy).then(resolve);
        });
      });
      pendingSaves.set(sessionId, entry);
      return entry.written;
    },

    delete: (sessionId) => {
      pendingSaves.delete(sessionId);
      return runOnDatabase("Could not delete the thread copy:", undefined, (database) =>
        deleteRecord(database, sessionId),
      );
    },

    deleteAll: () => {
      pendingSaves.clear();
      return runOnDatabase("Could not delete the thread copies:", undefined, (database) =>
        runTransaction(database, [THREADS_STORE], "readwrite", (transaction) => {
          transaction.objectStore(THREADS_STORE).clear();
        }),
      );
    },
  };
};
