/**
 * Tests reading the size and free space of the disk that holds a path, on the
 * real machine: a fake `statfs` would only repeat the multiplication.
 */
import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import { tmpdir } from "node:os";
import { readDiskSpace } from "./disk";

describe("readDiskSpace", () => {
  it("returns the size and the free bytes of the file system that holds a path", async () => {
    const disk = await Effect.runPromise(readDiskSpace(tmpdir()));

    expect(Number.isInteger(disk.totalBytes)).toBe(true);
    expect(Number.isInteger(disk.freeBytes)).toBe(true);
    expect(disk.freeBytes).toBeGreaterThan(0);
    expect(disk.freeBytes).toBeLessThanOrEqual(disk.totalBytes);
  });

  it("fails instead of guessing when the path does not exist", async () => {
    const outcome = await Effect.runPromise(
      Effect.result(readDiskSpace("/no/such/directory/on/this/machine")),
    );
    expect(outcome._tag).toBe("Failure");
  });
});
