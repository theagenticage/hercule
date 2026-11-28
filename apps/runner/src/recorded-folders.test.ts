/**
 * Tests the record of the folders harness adapters make. These tests check that:
 *
 * - a folder is made private, with a record that exists before it does, and
 *   removing it removes the record too;
 * - the sweep at runner start removes exactly the recorded folders, and leaves
 *   a folder with a matching name that the runner never recorded;
 * - a folder that cannot be removed is logged with its path and the reason,
 *   keeps its record for the next start, and does not stop the sweep;
 * - a record with no folder path in it is dropped.
 */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Logger } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { makeRecordedFolders, sweepRecordedFolders } from "./recorded-folders";

const scratch: Array<string> = [];
const locked: Array<string> = [];

afterEach(() => {
  for (const folder of locked.splice(0)) chmodSync(folder, 0o700);
  for (const folder of scratch.splice(0)) rmSync(folder, { recursive: true, force: true });
});

const createScratch = (): string => {
  const folder = mkdtempSync(join(tmpdir(), "hercule-recorded-folders-"));
  scratch.push(folder);
  return folder;
};

/** Runs the sweep and returns what it logged, each line with its level. */
const sweepAndReadLog = async (recordsDir: string): Promise<ReadonlyArray<string>> => {
  const lines: Array<string> = [];
  const logger = Logger.make<unknown, void>((options) => {
    lines.push(`${options.logLevel}: ${String(options.message)}`);
  });
  await Effect.runPromise(
    sweepRecordedFolders(recordsDir).pipe(Effect.provide(Logger.layer([logger]))),
  );
  return lines;
};

describe("making and removing a recorded folder", () => {
  it("makes a private folder and a record of it, and removes both together", () => {
    const root = createScratch();
    const recordsDir = join(root, "records");
    const folders = makeRecordedFolders(recordsDir);

    const folder = folders.make(root, "hercule-pi-agent-");

    expect(folder.startsWith(join(root, "hercule-pi-agent-"))).toBe(true);
    expect(statSync(folder).mode & 0o777).toBe(0o700);
    expect(readdirSync(recordsDir)).toHaveLength(1);

    folders.remove(folder);

    expect(existsSync(folder)).toBe(false);
    expect(readdirSync(recordsDir)).toEqual([]);
  });

  it("makes a different folder each time", () => {
    const root = createScratch();
    const folders = makeRecordedFolders(join(root, "records"));

    expect(folders.make(root, "x-")).not.toBe(folders.make(root, "x-"));
  });

  it("leaves no record when the folder cannot be made", () => {
    const root = createScratch();
    const recordsDir = join(root, "records");

    expect(() => makeRecordedFolders(recordsDir).make(join(root, "missing"), "x-")).toThrow();

    expect(readdirSync(recordsDir)).toEqual([]);
  });
});

describe("the sweep at runner start", () => {
  it("removes the recorded folders and their records, and leaves a folder it never recorded", async () => {
    const root = createScratch();
    const recordsDir = join(root, "records");
    const folders = makeRecordedFolders(recordsDir);
    const first = folders.make(root, "hercule-agy-");
    const second = folders.make(root, "hercule-log-");
    writeFileSync(join(first, "note.txt"), "left by an agent's command");
    // Same name pattern, made by someone else: a process of another runner.
    const stranger = join(root, "hercule-agy-another-runners");
    mkdirSync(stranger);

    const log = await sweepAndReadLog(recordsDir);

    expect(existsSync(first)).toBe(false);
    expect(existsSync(second)).toBe(false);
    expect(existsSync(stranger)).toBe(true);
    expect(readdirSync(recordsDir)).toEqual([]);
    expect(log.toSorted()).toEqual(
      [
        `Info: removed the leftover folder ${first} of an earlier run`,
        `Info: removed the leftover folder ${second} of an earlier run`,
      ].toSorted(),
    );
  });

  it("does nothing when there is no record yet", async () => {
    const root = createScratch();

    expect(await sweepAndReadLog(join(root, "never-made"))).toEqual([]);
  });

  it("logs the path and the reason of a folder it cannot remove, keeps its record, and goes on", async () => {
    const root = createScratch();
    const recordsDir = join(root, "records");
    const folders = makeRecordedFolders(recordsDir);
    // A folder in a parent that has no write permission: what a container
    // running as root leaves behind, without the test needing root.
    const lockedParent = join(root, "locked");
    mkdirSync(lockedParent);
    const blocked = folders.make(lockedParent, "hercule-agy-");
    chmodSync(lockedParent, 0o500);
    locked.push(lockedParent);
    const removable = folders.make(root, "hercule-agy-");

    const log = await sweepAndReadLog(recordsDir);

    expect(existsSync(removable)).toBe(false);
    expect(existsSync(blocked)).toBe(true);
    expect(readdirSync(recordsDir)).toHaveLength(1);
    expect(
      log.some(
        (line) => line.startsWith("Warn:") && line.includes(blocked) && line.includes("EACCES"),
      ),
    ).toBe(true);
  });

  it("drops a record that holds no folder path", async () => {
    const root = createScratch();
    const recordsDir = join(root, "records");
    mkdirSync(recordsDir);
    writeFileSync(join(recordsDir, "half-written"), "");

    const log = await sweepAndReadLog(recordsDir);

    expect(readdirSync(recordsDir)).toEqual([]);
    expect(log).toHaveLength(1);
    expect(log[0]).toContain("holds no folder path");
  });
});
