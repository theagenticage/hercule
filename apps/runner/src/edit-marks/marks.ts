/**
 * Mark files: how a gate lets the runner know that a tool is about to run.
 *
 * A gate is code of a harness that runs before a tool that can write files and
 * that the tool waits for. The gates of pi and Codex run in the harness's own
 * process, and create a mark file in the session's marks directory. (Claude
 * Code's gate runs in the runner's process and records its mark in memory
 * instead.) The file's ctime is the start of the tool's window on the file
 * clock (`clock.ts`), and its content names the tool call. The runner reads
 * the directory, and deletes each mark it read, when it lists changes and when
 * an item ends. So no message passes between the gate and the runner: the
 * file exists before the tool runs, and a read at any later moment finds it.
 * A gate that cannot create its mark file blocks the tool.
 *
 * The content is a JSON object with a field of a Codex hook input, so the
 * Codex hook can write the line it was given as it is: `tool_use_id`, the id
 * of the tool call, which is also the id of the item the harness reports for
 * it. Other fields are ignored.
 */
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Schema } from "effect";
import { truncateFact } from "../providers/text";

/**
 * The environment variable that holds a session's marks directory in the
 * process of a harness whose gate runs outside the runner (pi, Codex).
 */
export const SESSION_MARKS_DIR_VARIABLE = "HERCULE_SESSION_MARKS_DIR";

/** The fields of a mark file that the runner reads. */
const MarkContent = Schema.Struct({
  tool_use_id: Schema.String,
});

const decodeMarkContent = Schema.decodeUnknownOption(MarkContent);

/** A tool call that a gate announced. */
export interface StartMark {
  /** The id of the tool call, spelled as the id of its item. */
  readonly toolUseId: string;
  /** When the gate ran, from the file's ctime on the file clock. */
  readonly startNs: bigint;
}

/**
 * Creates a new, empty marks directory for one start of a session under
 * `editMarksDir`, and returns its path. Each start gets its own directory, so
 * a mark left by an earlier start never counts as a tool of this one, and the
 * teardown of an earlier start cannot delete it. Throws when the directory
 * cannot be made.
 */
export const createSessionMarksDir = (editMarksDir: string, sessionId: string): string => {
  const sessionsDir = join(editMarksDir, "sessions");
  mkdirSync(sessionsDir, { recursive: true, mode: 0o700 });
  return mkdtempSync(join(sessionsDir, `${sessionId}-`));
};

/**
 * Returns the content of the mark file of one tool call. The function uses
 * nothing outside its body, because the pi extension embeds its source as it
 * is.
 */
export const formatStartMark = (toolUseId: string): string =>
  JSON.stringify({ tool_use_id: toolUseId });

/**
 * Returns the mark files in `dir` that name a tool call, and deletes each one
 * it returns, so no mark is read twice. The ids are spelled as the adapters
 * spell item ids. A file that is empty or does not parse stays: its gate may
 * be in the middle of writing it, and a later call reads it again. A file
 * with an empty id names no item, so it is deleted and left out. Returns
 * nothing when the directory does not exist.
 */
export const takeStartMarks = (dir: string): ReadonlyArray<StartMark> => {
  let names: ReadonlyArray<string>;
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const marks: Array<StartMark> = [];
  for (const name of names) {
    const path = join(dir, name);
    try {
      const content = decodeMarkContent(JSON.parse(readFileSync(path, "utf8")));
      if (content._tag === "None") continue;
      // The content is read first. A file that parses has been written, and
      // its ctime is then the time of its last write.
      const startNs = lstatSync(path, { bigint: true }).ctimeNs;
      rmSync(path, { force: true });
      if (content.value.tool_use_id === "") continue;
      marks.push({
        toolUseId: truncateFact(content.value.tool_use_id),
        startNs,
      });
    } catch {
      continue;
    }
  }
  return marks;
};
