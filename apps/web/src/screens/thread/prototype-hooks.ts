/**
 * PROTOTYPE (#354), throwaway. The slots the subagents prototype fills in the
 * shell and the thread screen. The app leaves every slot empty, so it renders
 * exactly as it does without them. The prototype's entry point
 * (`src/prototype/subagents/main.tsx`) fills them before the app mounts.
 *
 * Each slot returns a component element, so the prototype's own components
 * read its state, and no app component needs to draw again when it changes.
 */
import type { ReactNode } from "react";
import type { ThreadTurn } from "@hercule/client-core";

export const prototypeHooks: {
  /** The side pane, drawn beside the shell's main column. */
  renderSidePane?: () => ReactNode;
  /** Drawn at the end of the thread header's actions. */
  renderHeaderActions?: () => ReactNode;
  /** Drawn above the composer, and above the queued messages. */
  renderAboveComposer?: () => ReactNode;
  /** Drawn directly on top of the permission card. */
  renderAboveRequest?: () => ReactNode;
  /** Drawn in a turn between the user's message and the agent's prose. */
  renderSpawnLines?: (turn: ThreadTurn) => ReactNode;
  /** Returns what the thread screen shows instead of `thread`, such as a subagent's page. */
  wrapThreadScreen?: (thread: ReactNode) => ReactNode;
} = {};
