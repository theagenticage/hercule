/**
 * A test helper that writes mark files the way the pi and Codex gates do.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { formatStartMark } from "./marks";

/**
 * Creates the mark file of one tool call in `dir`, as a gate does before the
 * tool runs. The file is created, then written, so its ctime is the moment of
 * the write. Throws when the file cannot be written.
 */
export const writeStartMark = (dir: string, call: { readonly toolUseId: string }): void => {
  const name = `${process.hrtime.bigint().toString()}-${Math.random().toString(36).slice(2)}`;
  writeFileSync(join(dir, name), formatStartMark(call.toolUseId), { flag: "wx", mode: 0o600 });
};
