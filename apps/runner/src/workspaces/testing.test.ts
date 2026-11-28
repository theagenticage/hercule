import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { cleanTemporaries, createTemporaryDir, snapshotContents } from "./testing";

afterAll(cleanTemporaries);

describe("snapshotContents", () => {
  it("is equal for an untouched folder, and an edit changes only the line of that file", () => {
    const dir = createTemporaryDir("hercule-snapshot-");
    mkdirSync(join(dir, "nested"));
    writeFileSync(join(dir, "kept.txt"), "kept\n");
    writeFileSync(join(dir, "nested", "edited.txt"), "before\n");
    const before = snapshotContents(dir);
    expect(snapshotContents(dir)).toBe(before);

    writeFileSync(join(dir, "nested", "edited.txt"), "after\n");

    // One line per file, so a failing comparison's diff shows only this line.
    const unchangedLines = new Set(before.split("\n"));
    const changedLines = snapshotContents(dir)
      .split("\n")
      .filter((line) => !unchangedLines.has(line));
    expect(changedLines).toHaveLength(1);
    expect(changedLines[0]).toContain("nested/edited.txt");
  });

  it("keeps two links apart from one link whose target looks like a second entry", () => {
    const first = createTemporaryDir("hercule-snapshot-");
    symlinkSync("foo", join(first, "a"));
    symlinkSync("bar", join(first, "b"));
    const second = createTemporaryDir("hercule-snapshot-");
    symlinkSync(`foo\n"b" mode=41471 -> "bar"`, join(second, "a"));

    expect(snapshotContents(second)).not.toBe(snapshotContents(first));
  });
});
