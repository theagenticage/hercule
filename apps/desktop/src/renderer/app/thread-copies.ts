import { decodeThreadCopy, type ThreadCopy } from "@hercule/client-core";

/**
 * The saved copies of recently opened threads, kept in IndexedDB so a thread
 * opens from disk instead of from the controller.
 *
 * Every method fails softly. When IndexedDB cannot be opened or used, the
 * failure is logged and the store behaves as if it held no copies, so a thread
 * is then read from the controller as usual. Nothing here caches in memory and
 * nothing here runs while a thread streams: the callers use it when a thread
 * opens, when its page closes and when a turn ends.
 */
export interface ThreadCopies {
  /**
   * Returns the saved copy of the thread, or undefined when there is none.
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
export const THREAD_COPY_FORMAT = 1;

/** The name of the IndexedDB database. It is exported so a test can open it. */
export const THREAD_COPIES_DATABASE = "hercule-thread-copies";

/** How many copies one project keeps. Threads with no project count as one project. */
const COPIES_PER_PROJECT = 25;

const THREADS_STORE = "threads";
const META_STORE = "meta";
const PROJECT_INDEX = "byProject";
const CONTROLLER_URL_KEY = "controllerUrl";

/** How long a save may wait for an idle moment before it runs anyway. */
const SAVE_IDLE_TIMEOUT_MS = 1000;

/** Runs `task` when the browser is idle, or on the next timer tick where there is no idle callback (jsdom). */
const runWhenIdle = (task: () => void): void => {
  if ("requestIdleCallback" in globalThis) {
    requestIdleCallback(task, { timeout: SAVE_IDLE_TIMEOUT_MS });
  } else {
    setTimeout(task, 0);
  }
};

/**
 * One saved thread, keyed by `sessionId`. IndexedDB cannot index `null`, so
 * `projectKey` is the project id, or "" for a thread in no project. The index
 * on `[projectKey, savedAt]` lists a project's copies from the oldest.
 */
interface ThreadCopyRecord {
  readonly format: number;
  readonly sessionId: string;
  readonly projectKey: string;
  readonly savedAt: number;
  readonly copy: ThreadCopy;
}

/** Waits for an IndexedDB request and returns its result. */
const readRequest = <T>(request: IDBRequest<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

/**
 * Runs `work` in one transaction and returns its result once the transaction
 * has committed. Fails when `work` fails or the transaction aborts, for
 * example when the disk quota is exceeded. `work` may only await requests of
 * this transaction, or the transaction ends before its next request.
 */
const runTransaction = async <T>(
  database: IDBDatabase,
  stores: readonly string[],
  mode: IDBTransactionMode,
  work: (transaction: IDBTransaction) => Promise<T>,
): Promise<T> => {
  const transaction = database.transaction([...stores], mode);
  const committed = new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
  const [result] = await Promise.all([work(transaction), committed]);
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
    const request = globalThis.indexedDB.open(THREAD_COPIES_DATABASE, 1);
    request.onupgradeneeded = () => {
      const threads = request.result.createObjectStore(THREADS_STORE, { keyPath: "sessionId" });
      threads.createIndex(PROJECT_INDEX, ["projectKey", "savedAt"]);
      request.result.createObjectStore(META_STORE);
    };
    // No `onblocked`: an upgrade waits until the other connections close, and
    // they close themselves in `onversionchange` below.
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  database.onversionchange = () => database.close();
  try {
    await runTransaction(
      database,
      [THREADS_STORE, META_STORE],
      "readwrite",
      async (transaction) => {
        const meta = transaction.objectStore(META_STORE);
        const savedUrl = await readRequest(meta.get(CONTROLLER_URL_KEY));
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
const decodeRecord = (record: unknown): ThreadCopy | undefined => {
  if (typeof record !== "object" || record === null) return undefined;
  if (!("format" in record) || record.format !== THREAD_COPY_FORMAT) return undefined;
  if (!("copy" in record)) return undefined;
  return decodeThreadCopy(record.copy);
};

/**
 * Creates the thread copy store for one controller. The database opens on
 * first use and stays open. If a different controller URL was saved before,
 * every copy is deleted before the first method runs.
 */
export const openThreadCopies = (controllerUrl: string): ThreadCopies => {
  let opening: Promise<IDBDatabase | undefined> | undefined;
  // Saves that wait for an idle moment, one per thread. Replacing an entry's
  // copy keeps its single scheduled write; removing the entry drops the save.
  const pendingSaves = new Map<string, { copy: ThreadCopy; written: Promise<void> }>();

  /** Returns the open database, or undefined (after logging once) when it cannot be opened. */
  const getDatabase = (): Promise<IDBDatabase | undefined> => {
    opening ??= openDatabase(controllerUrl).catch((error: unknown) => {
      console.error("Could not open the saved threads:", error);
      return undefined;
    });
    return opening;
  };

  /** Runs `work` on the database, or returns `fallback` when there is none or `work` fails (logged as `failure`). */
  const runOnDatabase = async <T>(
    failure: string,
    fallback: T,
    work: (database: IDBDatabase) => Promise<T>,
  ): Promise<T> => {
    const database = await getDatabase();
    if (database === undefined) return fallback;
    try {
      return await work(database);
    } catch (error) {
      console.error(failure, error);
      return fallback;
    }
  };

  const deleteRecord = (database: IDBDatabase, sessionId: string): Promise<void> =>
    runTransaction(database, [THREADS_STORE], "readwrite", async (transaction) => {
      transaction.objectStore(THREADS_STORE).delete(sessionId);
    });

  /** Writes the copy, then deletes the oldest copies of its project beyond the limit. */
  const writeCopy = (copy: ThreadCopy): Promise<void> =>
    runOnDatabase("Could not save the thread:", undefined, (database) =>
      runTransaction(database, [THREADS_STORE], "readwrite", async (transaction) => {
        const projectKey = copy.session.projectId ?? "";
        const record: ThreadCopyRecord = {
          format: THREAD_COPY_FORMAT,
          sessionId: copy.session.id,
          projectKey,
          savedAt: Date.now(),
          copy,
        };
        const threads = transaction.objectStore(THREADS_STORE);
        threads.put(record);
        // A copy is saved only while its thread is open, so the oldest
        // `savedAt` belongs to the thread opened longest ago. The index lists
        // a project's copies from the oldest, and the put above is already
        // counted because requests of one transaction run in order.
        const projectCopies = IDBKeyRange.bound([projectKey, -Infinity], [projectKey, Infinity]);
        const index = threads.index(PROJECT_INDEX);
        const excess = (await readRequest(index.count(projectCopies))) - COPIES_PER_PROJECT;
        if (excess <= 0) return;
        const oldest = await readRequest(index.getAllKeys(projectCopies, excess));
        for (const sessionId of oldest) threads.delete(sessionId);
      }),
    );

  return {
    read: (sessionId) =>
      runOnDatabase("Could not read the saved thread:", undefined, async (database) => {
        const record: unknown = await runTransaction(
          database,
          [THREADS_STORE],
          "readonly",
          (transaction) => readRequest(transaction.objectStore(THREADS_STORE).get(sessionId)),
        );
        if (record === undefined) return undefined;
        const copy = decodeRecord(record);
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
      return runOnDatabase("Could not delete the saved thread:", undefined, (database) =>
        deleteRecord(database, sessionId),
      );
    },

    deleteAll: () => {
      pendingSaves.clear();
      return runOnDatabase("Could not delete the saved threads:", undefined, (database) =>
        runTransaction(database, [THREADS_STORE], "readwrite", async (transaction) => {
          transaction.objectStore(THREADS_STORE).clear();
        }),
      );
    },
  };
};
