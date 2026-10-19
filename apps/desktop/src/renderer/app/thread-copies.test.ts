import type { ThreadCopy } from "@hercule/client-core";
import { IDBObjectStore } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildId, buildThreadCopyFixture as buildCopy } from "./testing-thread-copies";
import { openThreadCopies, THREAD_COPIES_DATABASE, THREAD_COPY_FORMAT } from "./thread-copies";

const CONTROLLER = "http://beelink:7777";
/** Opens the database the store made, to look at the records the way the disk holds them. */
const openRaw = (): Promise<IDBDatabase> =>
  new Promise((resolve, reject) => {
    const request = indexedDB.open(THREAD_COPIES_DATABASE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Opening the database failed."));
  });

/** Replaces the stored record of a thread, the way an older or newer app version would have left it. */
const rewriteRecord = async (
  sessionId: string,
  change: (record: Record<string, unknown>) => Record<string, unknown>,
): Promise<void> => {
  const database = await openRaw();
  const store = database.transaction("threads", "readwrite").objectStore("threads");
  store.get(sessionId).onsuccess = (event) => {
    const record = (event.target as IDBRequest<Record<string, unknown>>).result;
    store.put(change(record));
  };
  await new Promise((resolve) => {
    store.transaction.oncomplete = resolve;
  });
  database.close();
};

/** Returns how many records are stored. */
const countRecords = async (): Promise<number> => {
  const database = await openRaw();
  const count = await new Promise<number>((resolve) => {
    database.transaction("threads").objectStore("threads").count().onsuccess = (event) =>
      resolve((event.target as IDBRequest<number>).result);
  });
  database.close();
  return count;
};

describe("thread copies", () => {
  beforeEach(() => {
    // (The shared test setup gives each test a fresh IndexedDB.)
    // Only the clock is faked: fake-indexeddb and the idle save need real timers.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(0);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  /** Moves the clock on, so the next save is later than the earlier ones. */
  const tick = (): void => {
    vi.setSystemTime(Date.now() + 1000);
  };

  it("reads back what it saved, and reads a thread it never saved as undefined", async () => {
    const copies = openThreadCopies(CONTROLLER);
    const copy = buildCopy(buildId(1));

    await copies.save(copy);

    expect(await copies.read(buildId(1))).toEqual(copy);
    expect(await copies.read(buildId(2))).toBeUndefined();
  });

  it("deletes a record of another format when it reads it", async () => {
    const copies = openThreadCopies(CONTROLLER);
    await copies.save(buildCopy(buildId(1)));
    await rewriteRecord(buildId(1), (record) => ({ ...record, format: THREAD_COPY_FORMAT + 1 }));

    expect(await copies.read(buildId(1))).toBeUndefined();
    expect(await countRecords()).toBe(0);
  });

  it("deletes a copy that no longer fits the contract's schemas when it reads it", async () => {
    const copies = openThreadCopies(CONTROLLER);
    await copies.save({
      ...buildCopy(buildId(1)),
      transcript: "not rows",
    } as unknown as ThreadCopy);

    expect(await copies.read(buildId(1))).toBeUndefined();
    expect(await countRecords()).toBe(0);
  });

  it("keeps 25 copies per project, deleting the thread opened longest ago, and counts threads in no project as one project", async () => {
    const copies = openThreadCopies(CONTROLLER);
    await copies.save(buildCopy(buildId(100), null));
    for (let n = 0; n < 25; n++) {
      tick();
      await copies.save(buildCopy(buildId(n)));
    }
    tick();
    await copies.save(buildCopy(buildId(25)));
    // Opening s-1 again makes it the newest, so s-2 is now the oldest.
    tick();
    await copies.save(buildCopy(buildId(1)));
    tick();
    await copies.save(buildCopy(buildId(26)));

    expect(await copies.read(buildId(0))).toBeUndefined();
    expect(await copies.read(buildId(1))).toBeDefined();
    expect(await copies.read(buildId(2))).toBeUndefined();
    expect(await copies.read(buildId(3))).toBeDefined();
    expect(await copies.read(buildId(26))).toBeDefined();
    // The other project is untouched, however full this one is.
    expect(await copies.read(buildId(100))).toBeDefined();

    for (let n = 1; n < 26; n++) {
      tick();
      await copies.save(buildCopy(buildId(100 + n), null));
    }
    expect(await copies.read(buildId(100))).toBeUndefined();
    expect(await copies.read(buildId(101))).toBeDefined();
    expect(await copies.read(buildId(3))).toBeDefined();
  });

  it("deletes one copy, and every copy", async () => {
    const copies = openThreadCopies(CONTROLLER);
    await copies.save(buildCopy(buildId(1)));
    await copies.save(buildCopy(buildId(2), null));
    await copies.save(buildCopy(buildId(3), buildId(901)));

    await copies.delete(buildId(1));
    expect(await copies.read(buildId(1))).toBeUndefined();
    expect(await copies.read(buildId(2))).toBeDefined();

    await copies.deleteAll();
    expect(await copies.read(buildId(2))).toBeUndefined();
    expect(await copies.read(buildId(3))).toBeUndefined();
  });

  it("returns from a save at once and keeps only the newest of two saves of a thread", async () => {
    const copies = openThreadCopies(CONTROLLER);
    const writes = vi.spyOn(IDBObjectStore.prototype, "put");
    const older = buildCopy(buildId(1));
    const newer = { ...older, session: { ...older.session, title: "Newer" } };

    const first = copies.save(older);
    const second = copies.save(newer);
    expect(writes).not.toHaveBeenCalled();
    await Promise.all([first, second]);

    // The only other put is the controller URL, a string, saved when the database opened.
    expect(writes.mock.calls.filter(([value]) => typeof value === "object")).toHaveLength(1);
    expect((await copies.read(buildId(1)))?.session.title).toBe("Newer");
  });

  it("drops a pending save when the thread, or every thread, is deleted", async () => {
    const copies = openThreadCopies(CONTROLLER);

    const savedOne = copies.save(buildCopy(buildId(1)));
    await copies.delete(buildId(1));
    const savedTwo = copies.save(buildCopy(buildId(2)));
    await copies.deleteAll();
    await Promise.all([savedOne, savedTwo]);

    expect(await copies.read(buildId(1))).toBeUndefined();
    expect(await copies.read(buildId(2))).toBeUndefined();
    expect(await countRecords()).toBe(0);
  });

  it("deletes every copy when it opens for another controller, and keeps them for the same one", async () => {
    await openThreadCopies(CONTROLLER).save(buildCopy(buildId(1)));

    expect(await openThreadCopies(CONTROLLER).read(buildId(1))).toBeDefined();
    expect(await openThreadCopies("http://other:7777").read(buildId(1))).toBeUndefined();
    expect(await openThreadCopies(CONTROLLER).read(buildId(1))).toBeUndefined();
  });

  it("reads as no copy and logs once when IndexedDB is unavailable", async () => {
    vi.stubGlobal("indexedDB", undefined);
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const copies = openThreadCopies(CONTROLLER);

    await copies.save(buildCopy(buildId(1)));
    expect(await copies.read(buildId(1))).toBeUndefined();
    await copies.delete(buildId(1));
    await copies.deleteAll();

    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]?.[0]).toBe("Could not open the saved threads:");
  });
});
