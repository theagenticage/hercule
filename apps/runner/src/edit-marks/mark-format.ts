/**
 * The two things a gate needs to announce a tool call: where the marks go, and
 * what a mark holds. They live apart from `marks.ts` so a gate that runs as its
 * own short-lived process (the Antigravity pre-tool hook) links this file and
 * not the schema and protocol code that reads the marks.
 */

/**
 * The environment variable that holds a session's marks directory in the
 * process of a harness whose gate runs outside the runner (pi, Codex).
 */
export const SESSION_MARKS_DIR_VARIABLE = "HERCULE_SESSION_MARKS_DIR";

/**
 * Returns the content of the mark file of one tool call. Pass `shellCommand`
 * for a shell command, and leave it out for any other tool. The function uses
 * nothing outside its body, because the pi extension embeds its source as it
 * is.
 */
export const formatStartMark = (toolUseId: string, shellCommand?: string): string =>
  JSON.stringify(
    shellCommand === undefined
      ? { tool_use_id: toolUseId }
      : { tool_use_id: toolUseId, tool_name: "Bash", tool_input: { command: shellCommand } },
  );
