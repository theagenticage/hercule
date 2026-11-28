import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { cleanupHomes, createScratchHome } from "./harnesses/testing";
import { readFileStart } from "./read-file-start";

afterAll(cleanupHomes);

describe("readFileStart", () => {
  const scratch = createScratchHome("file-start");

  it("returns the whole text of a file that fits the buffer", () => {
    const path = join(scratch, "small.md");
    writeFileSync(path, "hello");

    expect(readFileStart(path, Buffer.alloc(64))).toEqual({ text: "hello", bytesRead: 5, size: 5 });
  });

  it("reads no more than the buffer holds and still reports the file's size", () => {
    const path = join(scratch, "large.md");
    writeFileSync(path, "abcdefghij");

    expect(readFileStart(path, Buffer.alloc(4))).toEqual({ text: "abcd", bytesRead: 4, size: 10 });
  });

  it("returns undefined for a folder and for a named pipe, without waiting on the pipe", () => {
    const folder = join(scratch, "folder");
    mkdirSync(folder);
    const pipe = join(scratch, "pipe");
    Bun.spawnSync(["mkfifo", pipe]);

    expect(readFileStart(folder, Buffer.alloc(4))).toBeUndefined();
    expect(readFileStart(pipe, Buffer.alloc(4))).toBeUndefined();
  });

  it("throws the file system error for a file that does not exist", () => {
    expect(() => readFileStart(join(scratch, "missing"), Buffer.alloc(4))).toThrow("ENOENT");
  });
});
