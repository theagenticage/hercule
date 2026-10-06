/**
 * The rows of the desktop sidebar's Assistants section: one per assistant,
 * with the pose its face shows and the word beside its name.
 */
import type { Assistant, Runner, Session } from "@hercule/contract";
import { decideThreadPose, type Pose } from "../threads/pose";

/** An assistant as its sidebar row shows it. */
export interface AssistantRow {
  /** The assistant's id. */
  readonly id: string;
  readonly name: string;
  /** `idle` while the assistant has no session yet. */
  readonly pose: Pose;
  /** The current session of the assistant's main conversation, or `null` when it has none. */
  readonly session: Session | null;
}

/**
 * Returns the pose of an assistant whose main conversation's current session
 * is `session`, on `runner`.
 *
 * - With no session yet, the pose is `idle`: the assistant waits for its
 *   first message.
 * - Otherwise it is a thread's pose, decided by `decideThreadPose`, so an
 *   assistant and a thread in the same state show the same face. A runner
 *   that is `undefined` counts as connected.
 */
export const decideAssistantPose = (session: Session | null, runner: Runner | undefined): Pose =>
  session === null ? "idle" : decideThreadPose(session, runner);

/**
 * Returns one row per assistant, sorted by name, and by id for two
 * assistants with the same name. Names are compared with `localeCompare`, so
 * the order follows the runtime's locale.
 *
 * - `currentSessions` holds the current session of each assistant's main
 *   conversation, by assistant id. An assistant missing from it has no
 *   session yet.
 * - `runners` decides whether a session's runner is disconnected, which
 *   makes the pose `away`. A runner missing from it counts as connected.
 *
 * Each pose is decided by `decideAssistantPose`.
 */
export const buildAssistantRows = (
  assistants: readonly Pick<Assistant, "id" | "name">[],
  currentSessions: ReadonlyMap<string, Session>,
  runners: readonly Runner[],
): AssistantRow[] =>
  assistants
    .map(({ id, name }): AssistantRow => {
      const session = currentSessions.get(id) ?? null;
      const runner =
        session === null ? undefined : runners.find((each) => each.id === session.runnerId);
      return { id, name, pose: decideAssistantPose(session, runner), session };
    })
    .sort((a, b) => a.name.localeCompare(b.name) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
