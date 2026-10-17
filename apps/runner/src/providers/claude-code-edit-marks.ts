/**
 * How a Claude Code session lets the edit watch know when its commands and
 * edits run (spec 19 section 4.1). Two parts:
 *
 * - The gate: a `PreToolUse` hook that takes the start mark of each tool
 *   that can write files. The hook runs inside the runner's own process, in
 *   every access mode, and the tool waits for it. So it records the mark in
 *   the runner's memory and writes no file, which leaves it no way to fail.
 * - The shells: a Bash command can leave its shell running after its tool
 *   call completed, and the shell can still write files. Claude Code makes a
 *   `local_bash` task of each shell that runs in the background or longer
 *   than about two seconds, and this module passes on when one starts and
 *   when it ends. A shorter shell has no task: its tool call's completion
 *   ends its window.
 */
import type { HookCallback, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { cleanItemId, FILE_WRITING_TOOLS } from "./claude-code-normalize";
import type { EditMarks } from "./index";

/** The matcher of the gate's hook, so no other tool waits for it. */
export const FILE_WRITING_TOOL_MATCHER = FILE_WRITING_TOOLS.join("|");

/**
 * Builds the gate: a `PreToolUse` hook that records the start mark of a tool
 * call that can write files, and lets every call through. The hook checks the
 * tool name itself as well, so a matcher that matches more names than it
 * lists changes nothing.
 */
export const buildStartMarkHook =
  (editMarks: EditMarks): HookCallback =>
  (input) => {
    if (input.hook_event_name === "PreToolUse" && FILE_WRITING_TOOLS.includes(input.tool_name)) {
      const toolUseId = cleanItemId(input.tool_use_id);
      if (toolUseId !== undefined) editMarks.recordToolStart(toolUseId);
    }
    return Promise.resolve({});
  };

/** The task statuses that `task_updated` reports for a shell that ended. */
const ENDED_STATUSES: ReadonlySet<string> = new Set(["completed", "failed", "killed"]);

/**
 * Passes on to the edit watch what one message shows about the shell of a
 * Bash call. A shell with a `local_bash` task can keep running, and writing
 * files, after its Bash call completed, so its task holds the window.
 * `shellItems` maps the task id of each running shell to the item id of the
 * Bash call that started it, because only `task_started` names the call:
 *
 * - `task_started` reports a shell that started.
 * - `task_notification`, or `task_updated` with a final status, reports that
 *   the shell ended.
 *
 * Call it before the message's events are published, so the watch learns
 * that a shell runs before it sees the Bash item complete.
 */
export const trackShellProcess = (
  editMarks: EditMarks,
  shellItems: Map<string, string>,
  message: SDKMessage,
): void => {
  if (message.type !== "system") return;
  switch (message.subtype) {
    case "task_started": {
      const itemId = cleanItemId(message.tool_use_id);
      if (message.task_type !== "local_bash" || itemId === undefined) return;
      shellItems.set(message.task_id, itemId);
      editMarks.recordProcessStart(itemId);
      return;
    }
    case "task_updated":
      if (message.patch.status !== undefined && ENDED_STATUSES.has(message.patch.status)) {
        endShellProcess(editMarks, shellItems, message.task_id);
      }
      return;
    case "task_notification":
      endShellProcess(editMarks, shellItems, message.task_id);
      return;
    default:
      return;
  }
};

/** Records the end of the shell of task `taskId`, once, if the shell was tracked. */
const endShellProcess = (
  editMarks: EditMarks,
  shellItems: Map<string, string>,
  taskId: string,
): void => {
  const itemId = shellItems.get(taskId);
  if (itemId === undefined) return;
  shellItems.delete(taskId);
  editMarks.recordProcessEnd(itemId);
};
