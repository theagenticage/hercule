/**
 * Returns the message of a `SteerRefused` for an input that has a skill and
 * reaches a session in the middle of a turn. `harnessName` is the name the
 * user knows the harness by, such as "Claude Code" or "Codex". The message
 * tells the user what happens to the input, and the user sees it as written.
 */
export const buildSkillSteerRefusedMessage = (harnessName: string): string =>
  `Not steered: ${harnessName} can't start a skill in the middle of a turn. The input stays queued and runs when this turn ends.`;
