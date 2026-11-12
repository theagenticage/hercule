import { describe, expect, it } from "vitest";
import {
  compareChunks,
  readFirstScreenRoutes,
  renderChunkTable,
  renderMeasureTable,
  stripChunkHash,
  type BuildSizes,
  type BuiltFile,
} from "./compare-bundle";

const file = (path: string, bytes: number): BuiltFile => ({
  path,
  bytes,
  gzipBytes: Math.round(bytes / 3),
});

describe("stripChunkHash", () => {
  it("removes the hash, including one with a hyphen or underscore", () => {
    expect(stripChunkHash("renderer/assets/inbox-B3v2P7XR.js")).toBe("renderer/assets/inbox.js");
    expect(stripChunkHash("renderer/assets/file-DkBzCv-7.js")).toBe("renderer/assets/file.js");
    expect(stripChunkHash("renderer/assets/_name-B9K3mL4d.css")).toBe("renderer/assets/_name.css");
  });

  it("leaves a file outside an assets folder unchanged", () => {
    expect(stripChunkHash("main/index.js")).toBe("main/index.js");
    expect(stripChunkHash("preload/index.cjs")).toBe("preload/index.cjs");
  });
});

describe("compareChunks", () => {
  it("lists only what changed, and names added and deleted chunks", () => {
    const rows = compareChunks(
      [
        file("a/assets/same-AAAAAAAA.js", 10),
        file("a/assets/grow-BBBBBBBB.js", 10),
        file("a/assets/gone-CCCCCCCC.js", 5),
      ],
      [
        file("a/assets/same-ZZZZZZZZ.js", 10),
        file("a/assets/grow-DDDDDDDD.js", 14),
        file("a/assets/new-EEEEEEEE.js", 7),
      ],
    );
    expect(rows.map((row) => [row.name, row.status, row.before, row.after])).toEqual([
      ["a/assets/new.js", "added", 0, 7],
      ["a/assets/gone.js", "deleted", 5, 0],
      ["a/assets/grow.js", "changed", 10, 14],
    ]);
  });

  it("sums names that collide after stripping and says how many files it summed", () => {
    const rows = compareChunks(
      [file("a/assets/_id-AAAAAAAA.js", 4), file("a/assets/_id-BBBBBBBB.js", 6)],
      [file("a/assets/_id-CCCCCCCC.js", 4), file("a/assets/_id-DDDDDDDD.js", 9)],
    );
    expect(rows).toEqual([
      { name: "a/assets/_id.js", before: 10, after: 13, status: "changed", fileCount: 2 },
    ]);
    expect(renderChunkTable(rows)).toContain(
      "a/assets/_id.js (2 files with this name, summed) | 10 | 13 | +3 | +30.0%",
    );
  });
});

describe("renderChunkTable", () => {
  it("says so when nothing changed", () => {
    expect(renderChunkTable([])).toBe("No chunk changed.");
  });
});

describe("renderMeasureTable", () => {
  const sizes = (bytes: number, firstScreenGzipBytes: number): BuildSizes => ({
    files: { main: [{ path: "index.js", bytes, gzipBytes: bytes }], preload: [], renderer: [] },
    firstScreenGzipBytes,
    mainStartupBytes: 1000,
  });

  it("shows before, after, delta and percent with thousands separators", () => {
    const table = renderMeasureTable(sizes(1000, 2000), sizes(900, 2500));
    expect(table).toContain("| renderer first screen, gzipped | 2,000 | 2,500 | +500 | +25.0% |");
    expect(table).toContain("| main, all files, gzipped | 1,000 | 900 | -100 | -10.0% |");
    expect(table).toContain("| main startup files, minified | 1,000 | 1,000 | 0 | 0.0% |");
  });

  it("shows a change under 0.05% as <0.1% with its sign", () => {
    expect(renderMeasureTable(sizes(1000, 1_000_000), sizes(1000, 1_000_001))).toContain(
      "| +1 | +<0.1% |",
    );
    expect(renderMeasureTable(sizes(1000, 1_000_000), sizes(1000, 999_999))).toContain(
      "| -1 | -<0.1% |",
    );
  });

  it("shows n/a for a percent of zero", () => {
    expect(renderMeasureTable(sizes(1000, 0), sizes(1000, 5))).toContain("| 0 | 5 | +5 | n/a |");
  });
});

describe("readFirstScreenRoutes", () => {
  it("fails when the script has no --route, instead of dropping the route chunks", () => {
    const packageJson = JSON.stringify({ scripts: { "build:desktop:bundle": "x --guide" } });
    expect(() => readFirstScreenRoutes(packageJson)).toThrow("no --route argument");
  });

  it("reads quoted and unquoted --route values from the build:desktop:bundle script", () => {
    const packageJson = JSON.stringify({
      scripts: { "build:desktop:bundle": "x --route a/b.tsx --route 'a/$id/c.tsx' --guide" },
    });
    expect(readFirstScreenRoutes(packageJson)).toEqual(["a/b.tsx", "a/$id/c.tsx"]);
  });
});
