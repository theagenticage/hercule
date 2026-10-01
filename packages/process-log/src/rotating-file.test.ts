import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openRotatingFile } from "./rotating-file";

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hercule-rotating-file-"));
  path = join(dir, "test.log");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const read = (file: string): string => readFileSync(file, "utf8");

describe("openRotatingFile", () => {
  it("appends to the file until the next line would pass the limit", () => {
    const file = openRotatingFile(path, 12);
    file.append("line 1\n");
    file.append("line 2\n");
    file.close();

    expect(read(path)).toBe("line 2\n");
    expect(read(`${path}.1`)).toBe("line 1\n");
  });

  it("keeps five rotated files and deletes the oldest", () => {
    const file = openRotatingFile(path, 7);
    for (let number = 1; number <= 8; number++) file.append(`line ${String(number)}\n`);
    file.close();

    expect(read(path)).toBe("line 8\n");
    expect(read(`${path}.1`)).toBe("line 7\n");
    expect(read(`${path}.5`)).toBe("line 3\n");
    expect(existsSync(`${path}.6`)).toBe(false);
  });

  it("writes a line longer than the limit into an empty file rather than rotating it", () => {
    const file = openRotatingFile(path, 4);
    file.append("a long line\n");
    file.close();

    expect(read(path)).toBe("a long line\n");
    expect(existsSync(`${path}.1`)).toBe(false);
  });

  it("counts what an existing file already holds", () => {
    writeFileSync(path, "from before\n");
    const file = openRotatingFile(path, 16);
    file.append("new line\n");
    file.close();

    expect(read(path)).toBe("new line\n");
    expect(read(`${path}.1`)).toBe("from before\n");
  });

  it("creates the file, and every file after a rotation, with mode 0600", () => {
    const file = openRotatingFile(path, 7);
    file.append("line 1\n");
    file.append("line 2\n");
    file.close();

    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(`${path}.1`).mode & 0o777).toBe(0o600);
  });

  it("restricts an existing file to mode 0600", () => {
    writeFileSync(path, "", { mode: 0o644 });
    openRotatingFile(path, 100).close();

    expect(statSync(path).mode & 0o777).toBe(0o600);
  });
});
