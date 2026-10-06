/**
 * Builders for the harness messages a Claude subagent produces, shared by the
 * normalizer's and the adapter's tests. They are written by hand in the shapes
 * the SDK's types give and with the ids the research runs observed
 * (docs/research/subagents-claude-code.md on the research branch).
 *
 * A subagent has two ids:
 *
 * - its agent call: the id of the `Agent` tool_use block that started it,
 *   which its frames carry as `parent_tool_use_id`;
 * - its agent id, the SubagentId, which `task_started` links to the agent call.
 */

/** The harness's own id for the test session. */
export const NATIVE = "a2c71f4c-13ba-41ba-b372-49675028b0b1";
export const SUBAGENT_MODEL = "claude-sonnet-4-5";
/** The brief an `Agent` call gives its subagent. */
export const BRIEF = "Find where the config file is read";

/**
 * Builds an `Agent` call, made by the session's own agent (`parent` null) or
 * by the subagent whose agent call is `parent`.
 */
export const buildAgentCall = (parent: string | null, agentCallId: string, name?: string) => ({
  type: "assistant",
  uuid: `uuid-${agentCallId}`,
  session_id: NATIVE,
  parent_tool_use_id: parent,
  message: {
    id: `msg-${agentCallId}`,
    role: "assistant",
    model: SUBAGENT_MODEL,
    content: [
      {
        type: "tool_use",
        id: agentCallId,
        name: "Agent",
        input: {
          description: "Find the config",
          prompt: BRIEF,
          subagent_type: "general-purpose",
          run_in_background: true,
          ...(name === undefined ? {} : { name }),
        },
      },
    ],
  },
});

/** Builds the `task_started` that links a task to the agent call that started it. */
export const buildTaskStarted = (
  taskId: string,
  agentCallId: string | undefined,
  taskType = "local_agent",
) => ({
  type: "system",
  subtype: "task_started",
  task_id: taskId,
  ...(agentCallId === undefined ? {} : { tool_use_id: agentCallId }),
  description: "Find the config",
  subagent_type: "general-purpose",
  is_backgrounded: true,
  spawn_depth: 1,
  task_type: taskType,
  prompt: BRIEF,
  uuid: `uuid-started-${taskId}`,
  session_id: NATIVE,
});

/** Builds the `task_notification` that reports how a task ended. */
export const buildTaskNotification = (
  taskId: string,
  agentCallId: string,
  status: "completed" | "failed" | "stopped" = "completed",
) => ({
  type: "system",
  subtype: "task_notification",
  task_id: taskId,
  tool_use_id: agentCallId,
  status,
  output_file: `/tmp/claude-501/tasks/${taskId}.output`,
  summary: "The config is read in src/config.ts",
  usage: { total_tokens: 1234, tool_uses: 2, duration_ms: 5000 },
  uuid: `uuid-notification-${taskId}`,
  session_id: NATIVE,
});

/** Builds an assistant message with one text block, from inside a subagent. */
export const buildSubagentText = (agentCallId: string, messageId: string, text: string) => ({
  type: "assistant",
  uuid: `uuid-${messageId}`,
  session_id: NATIVE,
  parent_tool_use_id: agentCallId,
  message: {
    id: messageId,
    role: "assistant",
    model: SUBAGENT_MODEL,
    content: [{ type: "text", text }],
  },
});
