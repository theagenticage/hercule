/**
 * The state of one agent of a session, as a transcript screen needs it to
 * draw that agent's transcript. A session has its own agent and any number of
 * subagents, and each has a transcript of its own. The rows of a transcript
 * do not say whether its last turn still runs, which Requests are open or
 * which model a turn ran on when the harness did not name one, so the
 * screen's records supply them. The builders below read them from the
 * Session or Subagent record, so both screens agree on what an agent's state
 * is.
 */
import type { Session, SessionRequest, Subagent } from "@hercule/contract";
import { mayBeRunningTurn } from "./turns";

export interface AgentState {
  /**
   * Whether the agent is working or about to, as its record says. Before the
   * agent's first turn, this alone decides whether the transcript shows the
   * working face.
   */
  readonly working: boolean;
  /**
   * Whether the agent may still be running a turn, as its records say. When
   * it may not, a turn that no row ended was cut short. When it may, the rows
   * decide, because the records may be older than they are.
   */
  readonly mayBeRunningTurn: boolean;
  /** The Requests this agent is parked on, oldest first. Another agent's are not here. */
  readonly openRequests: readonly SessionRequest[];
  /** The model shown for a turn whose rows do not name one. */
  readonly model: string;
}

/**
 * Builds the state of a session's own agent. Its Requests are the session's
 * open Requests that no subagent asked.
 */
export const buildSessionAgentState = (session: Session): AgentState => ({
  working: session.status === "starting" || session.status === "busy",
  mayBeRunningTurn: mayBeRunningTurn(session.status),
  openRequests: session.openRequests.filter((request) => request.subagentId === undefined),
  model: session.modelSelection.model,
});

/**
 * Builds the state of one subagent of `session`. Its Requests are the
 * session's open Requests it asked. The model is the session's until the
 * subagent's own turns name one.
 *
 * A subagent may be running a turn only while it runs and a harness process
 * runs its session. The session's status alone is not enough: a session
 * that exited mid-turn stops its subagents, and once the session is resumed
 * it reads `idle` again, while the subagent's transcript holds no row that
 * ended the cut-off turn.
 *
 * The cost: a subagent that ended and then starts a new turn reads as ended
 * until its record is read again, so for that moment the new turn shows as
 * cut short.
 */
export const buildSubagentAgentState = (subagent: Subagent, session: Session): AgentState => ({
  working: subagent.status === "running",
  mayBeRunningTurn: subagent.status === "running" && mayBeRunningTurn(session.status),
  openRequests: session.openRequests.filter((request) => request.subagentId === subagent.id),
  model: subagent.model ?? session.modelSelection.model,
});
