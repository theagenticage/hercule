/**
 * Tests the folder walk on real directories. Sizes are compared with `du`,
 * which counts allocated blocks and counts a hard-linked file once per run,
 * so the expected values do not come from the code under test.
 */
import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { walkFolder } from "./walker";

const scratch: string[] = [];

afterEach(() => {
  for (const folder of scratch.splice(0)) rmSync(folder, { recursive: true, force: true });
});

const makeScratch = (): string => {
  const folder = mkdtempSync(join(tmpdir(), "hercule-walker-"));
  scratch.push(folder);
  return folder;
};

/** Writes a file of `bytes` bytes of non-zero data, so every block is really allocated. */
const writeFile = (path: string, bytes: number): void => {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, Buffer.alloc(bytes, 7));
};

/** Returns the bytes `du` says a folder takes, hard links counted once. */
const duBytes = (folder: string): number =>
  Number(Bun.spawnSync(["du", "-sk", folder]).stdout.toString().split("\t")[0]) * 1024;

describe("walkFolder", () => {
  it("counts a file hard-linked from a store in the size and not in the bytes it frees", () => {
    const root = makeScratch();
    const store = join(root, "store", "pkg.js");
    writeFile(store, 300_000);
    const workspace = join(root, "workspace");
    mkdirSync(join(workspace, "node_modules"), { recursive: true });
    linkSync(store, join(workspace, "node_modules", "pkg.js"));
    writeFile(join(workspace, "own.txt"), 100_000);

    const usage = walkFolder(workspace);

    const linked = statSync(store).blocks * 512;
    expect(usage.sizeBytes - usage.freesBytes).toBe(linked);
    expect(usage.freesBytes).toBeGreaterThanOrEqual(100_000);
    expect(usage.sizeBytes).toBeGreaterThanOrEqual(400_000);
  });

  it("never counts a block twice when ten workspaces link one store", () => {
    const root = makeScratch();
    const store = join(root, "store");
    writeFile(join(store, "a.js"), 200_000);
    writeFile(join(store, "b.js"), 150_000);
    const workspaces = Array.from({ length: 10 }, (_, at) => join(root, `workspace-${String(at)}`));
    for (const [at, workspace] of workspaces.entries()) {
      mkdirSync(join(workspace, "node_modules"), { recursive: true });
      linkSync(join(store, "a.js"), join(workspace, "node_modules", "a.js"));
      linkSync(join(store, "b.js"), join(workspace, "node_modules", "b.js"));
      writeFile(join(workspace, "own.txt"), 10_000 + at * 4096);
    }

    const usages = workspaces.map(walkFolder);
    const freed = usages.reduce((sum, usage) => sum + usage.freesBytes, 0);
    const summedSizes = usages.reduce((sum, usage) => sum + usage.sizeBytes, 0);
    const allocated = duBytes(root);

    // The freed parts and the store are what `du` finds in the whole tree,
    // except for the directory that holds them all.
    expect(freed + walkFolder(store).sizeBytes).toBeLessThanOrEqual(allocated);
    // Adding the sizes would count the store ten times.
    expect(summedSizes).toBeGreaterThan(allocated);
  });

  it("counts a file with two links inside the folder once in the size, and none of it as freed", () => {
    const root = makeScratch();
    writeFile(join(root, "a.bin"), 200_000);
    linkSync(join(root, "a.bin"), join(root, "b.bin"));

    const usage = walkFolder(root);

    expect(usage.sizeBytes - usage.freesBytes).toBe(statSync(join(root, "a.bin")).blocks * 512);
    expect(usage.sizeBytes).toBeLessThan(2 * 200_000);
  });

  it("does not follow a symbolic link", () => {
    const root = makeScratch();
    writeFile(join(root, "outside", "big.bin"), 500_000);
    const folder = join(root, "folder");
    mkdirSync(folder);
    symlinkSync(join(root, "outside"), join(folder, "link"));

    expect(walkFolder(folder).sizeBytes).toBeLessThan(100_000);
  });

  it("fails when the folder does not exist", () => {
    expect(() => walkFolder(join(makeScratch(), "missing"))).toThrow(/missing/);
  });
});
