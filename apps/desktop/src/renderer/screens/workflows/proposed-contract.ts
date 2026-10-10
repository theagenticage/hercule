/**
 * PROTOTYPE. The contract additions the Workflows page needs, written here so
 * the prototype can draw them before the contract has them. The Workflows
 * ticket moves each one into `@hercule/contract`, and this file goes away.
 *
 * Everything else the page reads already exists: `trigger.query` gives each
 * trigger with its next fire time, `run.query` a workflow's runs, `run.read`
 * one run with its plan and step records, and `session.query` with `runId`
 * the sessions a run's agent steps started, with their open Requests.
 */
import type {
  RunStatus,
  Session,
  Workflow,
  WorkflowDefinition,
  WorkflowSummary,
} from "@hercule/contract";

/**
 * One of a workflow's latest runs, as its row in the workflow list shows it.
 * Proposed as an element of `WorkflowSummary.recentRuns`.
 */
export interface RecentRun {
  readonly id: string;
  readonly status: RunStatus;
  /**
   * Whether a session the run's agent steps started has an open Request: the
   * run is live and waits on the user. Always false for a run that has ended.
   */
  readonly waitingOnUser: boolean;
  readonly createdAt: string;
  /** When the run ended. Absent while it is pending or running. */
  readonly finishedAt?: string;
  /**
   * Where the run is, or where it stopped:
   *
   * - a failed run: the step it failed at;
   * - a live run: its running steps; with none running, the steps waiting
   *   to start; with none of those either, the signal triggers it awaits;
   * - a completed or cancelled run: none.
   */
  readonly stepIds: ReadonlyArray<string>;
}

/**
 * A workflow in the list, with its latest runs. Proposed as a new field on
 * `WorkflowSummary`, so the list stays current without reading every run.
 * It replaces the earlier `latestRun` proposal: the latest run is the first
 * entry.
 *
 * The field changes more often than the rest of the summary: when a run
 * starts or ends, moves to another step, or opens or closes a Request. Each
 * change is pushed on the `workflow` topic, and today a push makes the list
 * read again. The ticket decides whether that read stays cheap enough with
 * many live runs, or whether the push should carry the changed row.
 */
export interface WorkflowListEntry extends WorkflowSummary {
  /** The workflow's runs, newest first, at most `RECENT_RUN_LIMIT`. */
  readonly recentRuns: ReadonlyArray<RecentRun>;
}

/** The most runs `WorkflowListEntry.recentRuns` holds. */
export const RECENT_RUN_LIMIT = 20;

/**
 * A workflow with its source parsed. Proposed as a new field on what
 * `workflow.read` returns, so a client draws the graph without parsing YAML.
 * A stored workflow always parses: the controller refuses to save one that
 * does not.
 */
export interface WorkflowWithDefinition extends Workflow {
  readonly definition: WorkflowDefinition;
}

/**
 * A session, with how many tool calls it made. Proposed as a new field on
 * `Session`, so a step's card on the graph says how much work its session
 * did. The count covers the session's own agent and all its subagents, over
 * the session's whole life, as `Session.usage` does for tokens. The
 * controller counts it as it counts `Subagent.toolCalls`: every item of a
 * tool-call kind, calls on subagents included.
 */
export interface SessionWithToolCalls extends Session {
  readonly toolCalls: number;
}

/**
 * Returns how many tool calls `session` made, or `undefined` for a session
 * read from a controller that does not count them yet, which the card shows
 * as not reported.
 */
export const readToolCalls = (session: Session): number | undefined =>
  "toolCalls" in session && typeof session.toolCalls === "number" ? session.toolCalls : undefined;
