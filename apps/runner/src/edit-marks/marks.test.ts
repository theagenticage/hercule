import { lstatSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_FACT_LENGTH } from "@hercule/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { truncateFact } from "../providers/text";
import { openFileClock } from "./clock";
import { createSessionMarksDir, takeStartMarks } from "./marks";
import { writeStartMark } from "./testing";

const roots: Array<string> = [];
const makeRoot = (): string => {
  const root = mkdtempSync(join(tmpdir(), "hercule-edit-marks-"));
  roots.push(root);
  return root;
};

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("the file clock", () => {
  it("never goes back, and holds the ctime of a write made between two marks, inclusive at both ends", () => {
    const root = makeRoot();
    const clock = openFileClock(join(root, "clock", "marker"));
    const file = join(root, "changed.txt");
    for (let round = 0; round < 200; round += 1) {
      const start = clock.takeMark();
      writeFileSync(file, String(round));
      const end = clock.takeMark();
      const ctime = lstatSync(file, { bigint: true }).ctimeNs;
      // On macOS the write lands strictly inside. On Linux the clock moves in
      // ticks of a few milliseconds, so the write often ties with a mark.
      expect(start <= ctime && ctime <= end, `round ${round}`).toBe(true);
      expect(end >= start).toBe(true);
    }
  });
});

describe("mark files", () => {
  it("takes a mark written for a tool call, with a start that falls between two marks of the clock", () => {
    const root = makeRoot();
    const clock = openFileClock(join(root, "marker"));
    const dir = createSessionMarksDir(root, "session-1");
    const before = clock.takeMark();
    writeStartMark(dir, { toolUseId: "call-1" });
    writeStartMark(dir, { toolUseId: "call-2" });
    const after = clock.takeMark();
    const marks = takeStartMarks(dir);
    expect(marks.map(({ toolUseId }) => toolUseId).sort()).toEqual(["call-1", "call-2"]);
    for (const mark of marks) expect(before <= mark.startNs && mark.startNs <= after).toBe(true);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("leaves empty files and files that do not parse for a later read, and takes them once they do", () => {
    const root = makeRoot();
    const dir = createSessionMarksDir(root, "session-1");
    writeFileSync(join(dir, "empty"), "");
    writeFileSync(join(dir, "half"), '{"tool_use_id":"ca');
    writeFileSync(join(dir, "other"), '{"unrelated":1}');
    expect(takeStartMarks(dir)).toEqual([]);
    writeFileSync(join(dir, "half"), '{"tool_use_id":"call","agent_id":"a"}');
    expect(takeStartMarks(dir)).toMatchObject([{ toolUseId: "call" }]);
    expect(readdirSync(dir).sort()).toEqual(["empty", "other"]);
  });

  it("spells ids as the adapters spell item ids, and deletes a mark with no id", () => {
    const root = makeRoot();
    const dir = createSessionMarksDir(root, "session-1");
    const long = "x".repeat(MAX_FACT_LENGTH + 10);
    writeFileSync(join(dir, "long"), JSON.stringify({ tool_use_id: long }));
    writeFileSync(join(dir, "blank"), JSON.stringify({ tool_use_id: "" }));
    expect(takeStartMarks(dir)).toMatchObject([{ toolUseId: truncateFact(long) }]);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("takes the whole hook input of Codex as a mark", () => {
    const root = makeRoot();
    const dir = createSessionMarksDir(root, "session-1");
    writeFileSync(
      join(dir, "hook"),
      JSON.stringify({
        session_id: "s",
        turn_id: "t",
        tool_name: "Bash",
        tool_input: { command: "echo x > f" },
        tool_use_id: "call-9",
      }),
    );
    expect(takeStartMarks(dir)).toEqual([
      expect.objectContaining({ toolUseId: "call-9", shellCommand: "echo x > f" }),
    ]);
  });

  it("reads a shell command from the marks the gates write, and no command from another tool", () => {
    const root = makeRoot();
    const dir = createSessionMarksDir(root, "session-1");
    writeStartMark(dir, { toolUseId: "shell", shellCommand: "git merge main" });
    writeStartMark(dir, { toolUseId: "edit" });
    writeFileSync(
      join(dir, "patch"),
      JSON.stringify({
        tool_name: "apply_patch",
        tool_input: { command: "*** Begin Patch" },
        tool_use_id: "patch",
      }),
    );
    const byId = Object.fromEntries(
      takeStartMarks(dir).map((mark) => [mark.toolUseId, mark.shellCommand]),
    );
    expect(byId).toEqual({ shell: "git merge main", edit: undefined, patch: undefined });
  });

  it("finds nothing in a directory that does not exist", () => {
    expect(takeStartMarks(join(makeRoot(), "missing"))).toEqual([]);
  });

  it("creates a new, empty directory for each start of a session", () => {
    const root = makeRoot();
    const first = createSessionMarksDir(root, "session-1");
    writeStartMark(first, { toolUseId: "left-over" });
    const second = createSessionMarksDir(root, "session-1");
    expect(second).not.toBe(first);
    expect(takeStartMarks(second)).toEqual([]);
    expect(readdirSync(first)).toHaveLength(1);
  });
});
