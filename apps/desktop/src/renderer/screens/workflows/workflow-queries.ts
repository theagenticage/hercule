/**
 * PROTOTYPE. The reads the Workflows page makes, as query options. The
 * Workflows ticket moves them into app/queries.ts beside the others.
 *
 * Two reads need a contract addition (see proposed-contract.ts). Their
 * query function fails with a message that names the addition, so the
 * prototype only draws from a specimen's seeded cache. They take no client
 * until the contract has the addition.
 *
 * A workflow is read as it is stored, with its YAML source. The page that
 * draws it parses the source itself (`parseWorkflowSourceWithRanges`), which
 * keeps the YAML parser out of this module: the shell imports this module
 * for Waiting on you, so everything it imports loads with the first screen.
 */
import { infiniteQueryOptions, queryOptions } from "@tanstack/react-query";
import { queryKeys, readEveryPage, type HerculeClient } from "@hercule/client-core";
import type { Run, Session, Workflow, WorkflowAction } from "@hercule/contract";
import { isWorthRetrying } from "../../app/queries";
import type { WorkflowListEntry } from "./proposed-contract";

/** The live connection keeps these reads current, so the cache never refetches on its own. */
const LIVE_KEPT_READ_OPTIONS = {
  staleTime: Infinity,
  refetchOnWindowFocus: false,
  refetchOnReconnect: false,
} as const;

/** Returns an error for a read the contract cannot serve yet, naming the field it lacks. */
const buildMissingFieldError = (field: string): Error =>
  new Error(`The Workflows prototype reads ${field}, which the contract does not have yet.`);

/** Reads every workflow with its latest runs, for the workflow list. */
export const workflowListQuery = () =>
  queryOptions({
    queryKey: queryKeys.workflows(),
    queryFn: (): Promise<ReadonlyArray<WorkflowListEntry>> =>
      Promise.reject(buildMissingFieldError("WorkflowSummary.recentRuns")),
    ...LIVE_KEPT_READ_OPTIONS,
  });

/**
 * Reads one workflow with its source, for its page and for the page of each
 * of its runs. A run outlives its workflow, so on a run's page the read can
 * fail with `not_found`; it is not retried then.
 */
export const workflowQuery = (client: HerculeClient, workflowId: string) =>
  queryOptions({
    queryKey: queryKeys.workflow(workflowId),
    queryFn: (): Promise<Workflow> => client.workflow.read({ params: { id: workflowId } }),
    retry: isWorthRetrying,
    ...LIVE_KEPT_READ_OPTIONS,
  });

/**
 * Reads the sessions of every live run that wait on the user, for the
 * Requests the list and Waiting on you show.
 */
export const waitingRunSessionsQuery = () =>
  queryOptions({
    queryKey: [...queryKeys.sessions(), "waiting-runs"],
    queryFn: (): Promise<ReadonlyArray<Session>> =>
      Promise.reject(buildMissingFieldError("session.query's run and waiting filters")),
    ...LIVE_KEPT_READ_OPTIONS,
  });

/** Reads every trigger of every workflow, for the list's Starts on and Next columns. */
export const triggersQuery = (client: HerculeClient) =>
  queryOptions({
    queryKey: queryKeys.triggers(),
    queryFn: () => readEveryPage((page) => client.trigger.query({ query: page })),
    ...LIVE_KEPT_READ_OPTIONS,
  });

/**
 * Reads one workflow's triggers, for its page. A `workflow` push that names
 * the workflow refetches them, so a trigger the user pauses shows paused.
 */
export const workflowTriggersQuery = (client: HerculeClient, workflowId: string) =>
  queryOptions({
    queryKey: queryKeys.triggers(workflowId),
    queryFn: () =>
      readEveryPage((page) => client.trigger.query({ query: { workflowId, ...page } })),
    ...LIVE_KEPT_READ_OPTIONS,
  });

/** Reads the workflow actions, whose display names label a graph's action steps. */
export const workflowActionsQuery = (client: HerculeClient) =>
  queryOptions({
    queryKey: queryKeys.workflowActions(),
    queryFn: (): Promise<ReadonlyArray<WorkflowAction>> => client.workflowAction.query(),
    staleTime: Infinity,
  });

/**
 * Reads a workflow's runs, newest first, a page at a time, for the Runs tab
 * of its page. A workflow can have thousands of runs, so the tab reads the
 * next page only when the user scrolls to the end of the last.
 */
export const workflowRunsQuery = (client: HerculeClient, workflowId: string) =>
  infiniteQueryOptions({
    queryKey: queryKeys.runs({ workflowId }),
    queryFn: ({ pageParam }) =>
      client.run.query({
        query: pageParam === undefined ? { workflowId } : { workflowId, cursor: pageParam },
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor,
    ...LIVE_KEPT_READ_OPTIONS,
  });

/** Reads one run with its plan and step records, for its page. */
export const runQuery = (client: HerculeClient, runId: string) =>
  queryOptions({
    queryKey: queryKeys.run(runId),
    queryFn: (): Promise<Run> => client.run.read({ params: { id: runId } }),
    retry: isWorthRetrying,
    ...LIVE_KEPT_READ_OPTIONS,
  });

/**
 * Reads the sessions a run's agent steps started, for its page: their open
 * Requests mark a step as waiting, and their usage fills each step's card.
 */
export const runSessionsQuery = (client: HerculeClient, runId: string) =>
  queryOptions({
    queryKey: queryKeys.sessions({ runId }),
    queryFn: () => readEveryPage((page) => client.session.query({ query: { runId, ...page } })),
    ...LIVE_KEPT_READ_OPTIONS,
  });

/**
 * Reads every run of a workflow created between `since` and `until`, for one
 * day of the Runs tab's timeline.
 */
export const workflowRunsBetweenQuery = (
  client: HerculeClient,
  workflowId: string,
  since: string,
  until: string,
) =>
  queryOptions({
    queryKey: queryKeys.runs({ workflowId, since, until }),
    queryFn: () =>
      readEveryPage((page) => client.run.query({ query: { workflowId, since, until, ...page } })),
    ...LIVE_KEPT_READ_OPTIONS,
  });

/**
 * Reads every run of a workflow that is still running, for the Runs tab's
 * timeline: a run can wait on the user for days, so it runs on days long
 * after the one it was created on.
 */
export const workflowRunningRunsQuery = (client: HerculeClient, workflowId: string) =>
  queryOptions({
    queryKey: queryKeys.runs({ workflowId, status: "running" }),
    queryFn: () =>
      readEveryPage((page) =>
        client.run.query({ query: { workflowId, status: "running", ...page } }),
      ),
    ...LIVE_KEPT_READ_OPTIONS,
  });
