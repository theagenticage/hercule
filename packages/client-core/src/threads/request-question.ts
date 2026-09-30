/**
 * Formats the one line a Waiting on you row shows under the thread's title:
 * what the agent is asking, such as "Run git push?". The permission card
 * (`buildApprovalCard`) asks the same thing at length; this line only names
 * the subject, so the user can tell the waiting threads apart at a glance.
 */
import type { OpenRequest } from "@hercule/contract";

/**
 * Returns the last part of a path: a file's name, or a directory's name when
 * the path ends in "/", such as "src" for "/Users/x/src/". Returns the whole
 * path when it has no last part, as "/" has none.
 */
const readFileName = (path: string): string => {
  const trimmed = path.replace(/\/+$/, "");
  const name = trimmed.slice(trimmed.lastIndexOf("/") + 1);
  return name === "" ? path : name;
};

/**
 * Returns what a file request asks for, such as "Change checkout.ts?" or
 * "Read 3 files?". A request with no path asks about "files", because some
 * harnesses do not say which files a change touches.
 */
const describeFiles = (verb: string, paths: readonly string[]): string => {
  if (paths.length === 0) return `${verb} files?`;
  if (paths.length === 1) return `${verb} ${readFileName(paths[0]!)}?`;
  return `${verb} ${String(paths.length)} files?`;
};

/**
 * Returns the one-line question for an open request:
 *
 * - a command: "Run <the command's first non-empty line>?", or "Run this
 *   command?" when the harness sent no command;
 * - a file change or read: the file's name, or how many files;
 * - a tool call: "Run <tool name>?";
 * - a question: the first question, in the agent's own words.
 *
 * The line may be long; the row shortens it with an ellipsis.
 */
export const formatRequestQuestion = (request: OpenRequest): string => {
  switch (request.kind) {
    case "command_approval": {
      const line = request.detail.command
        .split("\n")
        .map((each) => each.trim())
        .find((each) => each !== "");
      return line === undefined ? "Run this command?" : `Run ${line}?`;
    }
    case "file_change_approval":
      return describeFiles("Change", request.detail.paths);
    case "file_read_approval":
      return describeFiles("Read", request.detail.paths);
    case "tool_approval":
      return `Run ${request.detail.toolName}?`;
    case "question":
      return request.detail.questions[0].question;
  }
};
