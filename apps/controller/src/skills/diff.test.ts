import { describe, expect, it } from "vitest";
import type { SkillFile, SkillFileMode } from "@hercule/protocol";
import { computeSkillFileChanges } from "./diff";

const utf8 = new TextEncoder();

const file = (
  path: string,
  content: string | Uint8Array,
  mode: SkillFileMode = "644",
): SkillFile => ({
  path,
  mode,
  content: typeof content === "string" ? utf8.encode(content) : content,
});

/** Returns a text of `count` numbered lines, each ending in a newline. */
const numberedLines = (count: number): string =>
  Array.from({ length: count }, (_, index) => `line ${index + 1}\n`).join("");

/** Returns the patch of the only change between one file and another at the same path. */
const patchBetween = (before: string, after: string): string | null =>
  computeSkillFileChanges([file("a.md", before)], [file("a.md", after)])[0]!.patch;

const MIB = 1024 * 1024;

describe("computeSkillFileChanges", () => {
  it("reports each kind of change, sorted by path, and leaves out unchanged files", () => {
    const current = [
      file("SKILL.md", "same\n"),
      file("notes.md", "old\n"),
      file("run.sh", "echo hi\n"),
      file("gone.md", "bye\n"),
    ];
    const revision = [
      file("run.sh", "echo hi\n", "755"),
      file("notes.md", "new\n", "755"),
      file("SKILL.md", "same\n"),
      file("added.md", "hello\nworld\n"),
    ];

    expect(computeSkillFileChanges(current, revision)).toEqual([
      {
        path: "added.md",
        change: "added",
        mode: "644",
        patch: "@@ -0,0 +1,2 @@\n+hello\n+world\n",
        patchOmitted: null,
      },
      {
        path: "gone.md",
        change: "removed",
        mode: null,
        patch: "@@ -1,1 +0,0 @@\n-bye\n",
        patchOmitted: null,
      },
      {
        path: "notes.md",
        change: "modified",
        mode: "755",
        patch: "@@ -1,1 +1,1 @@\n-old\n+new\n",
        patchOmitted: null,
      },
      { path: "run.sh", change: "modeChanged", mode: "755", patch: "", patchOmitted: null },
    ]);
  });

  it("reports every file as added when the Skill has no current revision", () => {
    const changes = computeSkillFileChanges(null, [file("b.md", "b\n"), file("a.md", "")]);
    expect(changes).toEqual([
      { path: "a.md", change: "added", mode: "644", patch: "", patchOmitted: null },
      {
        path: "b.md",
        change: "added",
        mode: "644",
        patch: "@@ -0,0 +1,1 @@\n+b\n",
        patchOmitted: null,
      },
    ]);
  });

  it("sorts paths by their UTF-8 bytes", () => {
    const paths = computeSkillFileChanges(null, [
      file("！.md", "x"),
      file("\u{1F600}.md", "x"),
      file("Z.md", "x"),
    ]).map((change) => change.path);
    expect(paths).toEqual(["Z.md", "！.md", "\u{1F600}.md"]);
  });

  it("shows three lines of context around a change", () => {
    const before = numberedLines(20);
    const after = before.replace("line 10\n", "line ten\n");
    expect(patchBetween(before, after)).toBe(
      "@@ -7,7 +7,7 @@\n line 7\n line 8\n line 9\n-line 10\n+line ten\n line 11\n line 12\n line 13\n",
    );
  });

  it("marks a missing newline at the end of a file", () => {
    expect(patchBetween("a\nb", "a\nb\n")).toBe(
      "@@ -1,2 +1,2 @@\n a\n-b\n\\ No newline at end of file\n+b\n",
    );
  });

  it("keeps CRLF line endings in the patch lines", () => {
    expect(patchBetween("a\r\nb\r\n", "a\r\nc\r\n")).toBe("@@ -1,2 +1,2 @@\n a\r\n-b\r\n+c\r\n");
  });

  it("shows a byte order mark that only one side has", () => {
    expect(patchBetween("a\n", "﻿a\n")).toBe("@@ -1,1 +1,1 @@\n-a\n+﻿a\n");
  });

  it.each([
    ["a NUL byte", new Uint8Array([0x61, 0x00, 0x62])],
    ["invalid UTF-8", new Uint8Array([0x61, 0xff, 0x62])],
  ])("omits the patch as binary when one side holds %s", (_, binary) => {
    const [modified, added] = computeSkillFileChanges(
      [file("a.bin", "text\n")],
      [file("a.bin", binary), file("b.bin", binary)],
    );
    expect(modified).toMatchObject({ change: "modified", patch: null, patchOmitted: "binary" });
    expect(added).toMatchObject({ change: "added", patch: null, patchOmitted: "binary" });
  });

  it("omits the patch as too large when either side is over 1 MiB", () => {
    const large = "x".repeat(MIB + 1);
    const changes = computeSkillFileChanges(
      [file("grew.md", "small\n"), file("shrank.md", large)],
      [file("grew.md", large), file("shrank.md", "small\n")],
    );
    expect(changes.map((change) => change.patchOmitted)).toEqual(["tooLarge", "tooLarge"]);
  });

  it("replaces every line in one hunk when the file differs in too many lines", () => {
    const before = numberedLines(600);
    const after = `${before.replaceAll("line", "row")}end`;
    const removed = before.replaceAll(/^/gm, "-").slice(0, -1);
    const added = after.replaceAll(/^/gm, "+");
    expect(patchBetween(before, after)).toBe(
      `@@ -1,600 +1,601 @@\n${removed}${added}\n\\ No newline at end of file\n`,
    );
  });

  it("gives the whole text of an added file with more lines than a diff compares", () => {
    const text = numberedLines(1500);
    const [added] = computeSkillFileChanges(null, [file("big.md", text)]);
    expect(added!.patch).toBe(`@@ -0,0 +1,1500 @@\n${text.replaceAll(/^/gm, "+").slice(0, -1)}`);
  });

  it("omits each patch that would bring the total, in path order, past 1 MiB", () => {
    // Each added file's patch is its content plus a header and a `+` per line,
    // so two of them fit under 1 MiB and a third does not.
    const third = `${"x".repeat(MIB / 3)}\n`;
    const changes = computeSkillFileChanges(null, [
      file("c.md", third),
      file("a.md", third),
      file("d.md", "small\n"),
      file("b.md", third),
    ]);
    expect(changes.map((change) => [change.path, change.patchOmitted])).toEqual([
      ["a.md", null],
      ["b.md", null],
      ["c.md", "tooLarge"],
      ["d.md", null],
    ]);
  });

  it("shares one budget of changed lines among all files, and replaces every line of the files past it", () => {
    // Each file changes every third of its 600 lines: 200 lines removed and
    // 200 added, so the budget of 4,000 covers ten files.
    const paths = Array.from({ length: 50 }, (_, index) => `${String(index).padStart(2, "0")}.md`);
    const before = numberedLines(600);
    const after = before.replaceAll(/^line (\d+)$/gm, (line, number: string) =>
      Number(number) % 3 === 0 ? `LINE ${number}` : line,
    );
    const changes = computeSkillFileChanges(
      paths.map((path) => file(path, before)),
      paths.map((path) => file(path, after)),
    );
    const diffed = changes.filter((change) => change.patch?.includes("\n line 1\n"));
    const replaced = changes.filter((change) =>
      change.patch?.startsWith("@@ -1,600 +1,600 @@\n-line 1\n-line 2\n"),
    );
    expect(diffed.map((change) => change.path)).toEqual(paths.slice(0, 10));
    expect(replaced).toHaveLength(40);
  });
});
