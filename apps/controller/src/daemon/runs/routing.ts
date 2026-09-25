/**
 * Routing: what a run does next when one of its step records finishes, and
 * whether a step's own condition lets its record start.
 *
 * Everything here reads a run as its rows were at one moment and returns a
 * decision; nothing here writes. The run engine re-reads the run inside the
 * transaction that finishes a record, asks for a decision, and writes it in
 * that same transaction. So every routing decision is made against rows no
 * other writer can change underneath it, and the rules can be tested without
 * a database.
 *
 * The words used below:
 *
 * - A record is active when it is `pending` or `running`.
 * - A step is live when it has an active record. A live step can still run,
 *   and so can every step it has a path of edges to.
 * - An incoming edge of a step is settled when its source can no longer run:
 *   the source is not live and no live step has a path to it. Conditions and
 *   `maxTraversals` are ignored when looking for a path, so a step upstream
 *   of a loop's active record counts as able to run until the loop is done.
 * - An edge fired when the run has followed it at least once.
 */
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import type * as Schema from "effect/Schema";
import type { FailedEdge, Run, WorkflowDefinition } from "@hercule/contract";
import { evaluateCondition, type ExpressionError } from "../../expressions";
import { isUnfinished } from "../../runs";

/**
 * The part of a run that routing reads: its plan, its inputs, its step records
 * in the order they were created, and how often it has followed each edge.
 */
export type RoutedRun = Pick<Run, "plan" | "inputs" | "steps" | "edgeTraversals">;

/** How the run goes on after a routing decision. */
export type RoutingEnding =
  | { readonly _tag: "continues" }
  | {
      readonly _tag: "completed";
      /** The output of the terminal step that ended the run, when one did. */
      readonly output?: Schema.Json;
    }
  | {
      readonly _tag: "failed";
      /**
       * - `expression-error`: the edge's condition could not be evaluated, or
       *   gave something other than true or false.
       * - `iteration-limit`: the edge's condition was true, but the run had
       *   already followed the edge as often as its `maxTraversals` allows.
       */
      readonly failureReason: "expression-error" | "iteration-limit";
      /** The edge the run failed at, and what went wrong there. */
      readonly failedEdge: FailedEdge;
    };

/**
 * What the run does after a step record finished:
 *
 * - `traversedEdgeIndexes`: the edges the run follows, by index in the plan's
 *   edges. Each one's traversal count goes up by one.
 * - `readyStepIds`: the steps that get a new pending record, in the order the
 *   records are to be created.
 * - `ending`: whether the run goes on, completes or fails.
 *
 * A failed run keeps the edges it followed and the records it created before
 * the edge it failed at. Those records are cancelled with every other active
 * record when the run fails.
 */
export interface RoutingDecision {
  readonly traversedEdgeIndexes: ReadonlyArray<number>;
  readonly readyStepIds: ReadonlyArray<string>;
  readonly ending: RoutingEnding;
}

/**
 * Builds the context that conditions and templates are evaluated against:
 * the run's `inputs`, and under `steps.<id>` the output of each step's latest
 * finished iteration. A step is absent from `steps` when it has not finished
 * yet, when it never runs, and when its latest finished iteration was
 * skipped, even if an earlier one completed. So `has(steps.x)` tells whether
 * the latest `x` produced an output.
 */
export const buildRunContext = (run: Pick<Run, "inputs" | "steps">): Record<string, unknown> => {
  const latest = new Map<string, Run["steps"][number]>();
  for (const record of run.steps) {
    if (record.status !== "completed" && record.status !== "skipped") continue;
    const known = latest.get(record.stepId);
    if (known === undefined || known.iteration < record.iteration) {
      latest.set(record.stepId, record);
    }
  }
  const steps: Record<string, unknown> = {};
  for (const [stepId, record] of latest) {
    if (record.status === "completed") steps[stepId] = { output: record.output };
  }
  return { inputs: run.inputs, steps };
};

/**
 * Checks whether a step's condition holds, so its record may start. A step
 * without a condition always may. Fails with `ExpressionError` if the
 * condition cannot be evaluated, or gives something other than true or false.
 */
export const isStepConditionMet = (
  run: RoutedRun,
  stepId: string,
): Effect.Effect<boolean, ExpressionError> => {
  const condition = run.plan.steps.find((step) => step.id === stepId)?.condition;
  return condition === undefined
    ? Effect.succeed(true)
    : evaluateCondition(condition, buildRunContext(run));
};

/**
 * Returns every step that `from` holds or has a path of edges to, `from`
 * included.
 *
 * `@hercule/client-core`'s `run-graph.ts` keeps a copy of this function,
 * because the web app cannot import the controller.
 */
const collectReachableSteps = (
  plan: WorkflowDefinition,
  from: Iterable<string>,
): ReadonlySet<string> => {
  const reached = new Set(from);
  // A Set iterator also visits values added during the iteration, so this
  // loop is a breadth-first search.
  for (const stepId of reached) {
    for (const edge of plan.edges ?? []) {
      if (edge.from === stepId) reached.add(edge.to);
    }
  }
  return reached;
};

/**
 * Returns the `join: all` steps that become ready, in the order their
 * records are to be created. A `join: all` step is ready once, when it has no
 * record yet, every incoming edge is settled, and at least one of them fired.
 * One whose incoming edges are all settled and none fired never runs: it gets
 * no record, and the steps only it leads to can then never run either.
 *
 * `live` holds the live steps, including the ones that are about to get a
 * record. A ready step becomes live itself, and may leave a later join
 * unsettled, so the steps are taken one at a time, each time one that no
 * other ready step has a path to. There always is one, because a `join: all`
 * step is never inside a loop.
 */
const listReadyJoins = (
  run: RoutedRun,
  traversals: ReadonlyArray<number>,
  live: ReadonlySet<string>,
): ReadonlyArray<string> => {
  const edges = run.plan.edges ?? [];
  const withRecord = new Set(run.steps.map((record) => record.stepId));
  const waiting = run.plan.steps.filter((step) => step.join === "all" && !withRecord.has(step.id));
  const nowLive = new Set(live);
  const ready: Array<string> = [];
  for (;;) {
    const canStillRun = collectReachableSteps(run.plan, nowLive);
    const candidates = waiting.filter((step) => {
      if (nowLive.has(step.id)) return false;
      const incoming = edges.flatMap((edge, index) => (edge.to === step.id ? [index] : []));
      return (
        incoming.every((index) => !canStillRun.has(edges[index]!.from)) &&
        incoming.some((index) => (traversals[index] ?? 0) > 0)
      );
    });
    const first = candidates.find(
      (candidate) =>
        !candidates.some(
          (other) =>
            other !== candidate && collectReachableSteps(run.plan, [other.id]).has(candidate.id),
        ),
    );
    if (first === undefined) return ready;
    ready.push(first.id);
    nowLive.add(first.id);
  }
};

/**
 * Decides what a run does after the latest record of `finishedStepId`
 * finished, by completing or by being skipped. `run` must already hold that
 * record as finished.
 *
 * A `terminal` step whose record completed ends the run: the run completes
 * with that record's output, and none of the step's outgoing edges is looked
 * at, so a terminal step can never fail its own run at an edge. A terminal
 * step that was skipped routes like any other skipped step.
 *
 * Otherwise the step's outgoing edges are taken in plan order. An edge whose
 * condition is false does nothing. An edge whose condition is absent or true
 * is followed: its count goes up by one, and a `join: any` target gets a new
 * record, while a `join: all` target only notes that the edge fired. The run
 * fails at the first edge whose condition cannot be decided, or that has been
 * followed as often as its `maxTraversals` allows; the edges after it are not
 * looked at.
 *
 * Then every `join: all` step that has become ready gets a record (see
 * `listReadyJoins`). When no step is live after that, the run completes.
 */
export const decideRouting = (
  run: RoutedRun,
  finishedStepId: string,
): Effect.Effect<RoutingDecision> =>
  Effect.gen(function* () {
    const step = run.plan.steps.find((candidate) => candidate.id === finishedStepId);
    if (step?.terminal === true) {
      // A step's records finish in iteration order, so the finished record
      // with the highest iteration is the one that has just finished.
      const finished = run.steps
        .filter((record) => record.stepId === finishedStepId && !isUnfinished(record.status))
        .reduce((latest, record) => (record.iteration > latest.iteration ? record : latest));
      if (finished.status === "completed") {
        return {
          traversedEdgeIndexes: [],
          readyStepIds: [],
          ending: { _tag: "completed", output: finished.output },
        };
      }
    }
    const edges = run.plan.edges ?? [];
    const context = buildRunContext(run);
    const traversals = [...run.edgeTraversals];
    const traversedEdgeIndexes: Array<number> = [];
    const readyStepIds: Array<string> = [];
    const buildDecision = (ending: RoutingEnding): RoutingDecision => ({
      traversedEdgeIndexes,
      readyStepIds,
      ending,
    });

    for (const [index, edge] of edges.entries()) {
      if (edge.from !== finishedStepId) continue;
      if (edge.condition !== undefined) {
        const holds = yield* Effect.result(evaluateCondition(edge.condition, context));
        if (Result.isFailure(holds)) {
          return buildDecision({
            _tag: "failed",
            failureReason: "expression-error",
            failedEdge: {
              index,
              message: `The condition of the edge from ${edge.from} to ${edge.to} could not be evaluated: ${holds.failure.message}`,
            },
          });
        }
        if (!holds.success) continue;
      }
      const count = traversals[index] ?? 0;
      if (edge.maxTraversals !== undefined && count >= edge.maxTraversals) {
        return buildDecision({
          _tag: "failed",
          failureReason: "iteration-limit",
          failedEdge: {
            index,
            // The message names the edge by its steps rather than its index,
            // because the user reads it on the run's page.
            message: `The run was to follow the edge from ${edge.from} to ${edge.to} again, but it has already followed it ${edge.maxTraversals === 1 ? "1 time" : `${String(edge.maxTraversals)} times`}, the most this edge allows.`,
          },
        });
      }
      traversals[index] = count + 1;
      traversedEdgeIndexes.push(index);
      const target = run.plan.steps.find((step) => step.id === edge.to);
      if (target?.join !== "all") readyStepIds.push(edge.to);
    }

    const live = new Set([
      ...run.steps.filter((record) => isUnfinished(record.status)).map((record) => record.stepId),
      ...readyStepIds,
    ]);
    const readyJoins = listReadyJoins(run, traversals, live);
    readyStepIds.push(...readyJoins);
    return buildDecision(
      live.size === 0 && readyJoins.length === 0 ? { _tag: "completed" } : { _tag: "continues" },
    );
  });
