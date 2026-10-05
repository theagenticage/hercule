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
   * Whether a harness process runs the agent. When none does, a turn that no
   * row ended was cut short. When one does, the rows decide, because the
   * record may be older than they are.
   */
  readonly harnessRunning: boolean;
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
  harnessRunning: mayBeRunningTurn(session.status),
  openRequests: session.openRequests.filter((request) => request.subagentId === undefined),
  model: session.modelSelection.model,
});

/**
 * Builds the state of one subagent of `session`. Its Requests are the
 * session's open Requests it asked. A subagent runs in its session's harness
 * process, so the session's status says whether that process runs; the model
 * is the session's until the subagent's own turns name one.
 */
export const buildSubagentAgentState = (subagent: Subagent, session: Session): AgentState => ({
  working: subagent.status === "running",
  harnessRunning: mayBeRunningTurn(session.status),
  openRequests: session.openRequests.filter((request) => request.subagentId === subagent.id),
  model: subagent.model ?? session.modelSelection.model,
});
