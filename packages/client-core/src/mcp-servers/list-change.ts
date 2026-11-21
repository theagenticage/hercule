/**
 * What a change to a started Thread's list of MCP Servers means for the agent
 * that is running now (spec 17, "When a change reaches the agent").
 */
import type { Harness, SessionStatus } from "@hercule/contract";

/**
 * Checks whether the harness picks up a tool list that changes while it runs,
 * so a server added now is usable at once.
 *
 * Claude Code is the only harness with the gateway today (`native`), and it
 * reads a changed list. Codex will be `native` once #1209 maps the gateway
 * into its adapter, but it reads a changed list only with a feature of its own
 * that is off by default. #1209 replaces the body of this function with the
 * harness capability it adds, and nothing else changes.
 */
const readsChangedToolList = (harness: Harness): boolean =>
  harness.declared.mcpPassthrough === "native";

/**
 * Returns the note that a server added now is usable only from the Thread's
 * next start, or `null` when there is nothing to say. The note is for a
 * started Thread whose process runs (`idle` or `busy`) and whose harness
 * gets the gateway but does not read a changed list. A Draft Thread, a queued
 * or exited Thread, and a harness with no gateway need none: the first three
 * start with the list as it is, and the last has its own warning from the
 * controller.
 *
 * `harness` is `undefined` while the harness list is not read.
 */
export const decideAddedServerNote = (
  harness: Harness | undefined,
  status: SessionStatus | "draft",
): string | null =>
  (status === "idle" || status === "busy") &&
  harness?.declared.mcpPassthrough === "native" &&
  !readsChangedToolList(harness)
    ? "A server added now is usable from the next start of this thread."
    : null;
