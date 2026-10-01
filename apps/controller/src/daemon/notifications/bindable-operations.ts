/**
 * The controller daemon's implementation of the notifications domain's
 * `BindableOperations` port: it runs the operation an answer carries, and
 * writes the describe line of one.
 *
 * It lives here because the operations belong to domains above the
 * notifications domain, and `session.input` and
 * `session.respondToApprovalRequest` go through
 * `Live`, which talks to runners.
 */
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import { dispatchBindableOperation, type BindableOperationHandlers } from "@hercule/contract";
import { BindableOperations, type BindableOperationError } from "../../notifications";
import { RunService } from "../../runs";
import { TaskService } from "../../tasks";
import { Live } from "../sessions";
import { buildDescribe } from "./describer";

const make = Effect.gen(function* () {
  const tasks = yield* TaskService;
  const runs = yield* RunService;
  const live = yield* Live;

  // Each runs in the caller's transaction and sends nothing to a runner until
  // it commits: `queueInput` stores the input and delivers it afterwards, and
  // `respondToApprovalRequest` sends its frame afterwards.
  const handlers: BindableOperationHandlers<Effect.Effect<unknown, BindableOperationError>> = {
    "task.update": ({ taskId, ...changes }) => tasks.update({ id: taskId, ...changes }),
    "run.start": (input) => runs.start(input),
    "session.input": ({ sessionId, ...input }) => live.queueInput({ id: sessionId, ...input }),
    "session.respondToApprovalRequest": ({ sessionId, ...decided }) =>
      live.respondToApprovalRequest({ id: sessionId, ...decided }),
  };

  return BindableOperations.of({
    run: (operation) => Effect.asVoid(dispatchBindableOperation(handlers, operation)),
    describe: yield* buildDescribe,
  });
});

/** The bindable operations, run with the task and run services and `Live`. */
export const BindableOperationsLayer: Layer.Layer<
  BindableOperations,
  never,
  SqlClient.SqlClient | TaskService | RunService | Live
> = Layer.effect(BindableOperations)(make);
