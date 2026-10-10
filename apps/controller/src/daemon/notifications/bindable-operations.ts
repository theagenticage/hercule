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
import type { PermissionProfiles } from "../../permissions";
import { RunService } from "../../runs";
import { TaskService } from "../../tasks";
import { PermissionRequests } from "../permissions";
import { Live } from "../sessions";
import { buildDescribe } from "./describer";

const make = Effect.gen(function* () {
  const tasks = yield* TaskService;
  const runs = yield* RunService;
  const live = yield* Live;
  const permissionRequests = yield* PermissionRequests;

  // Each runs in the caller's transaction and sends nothing to a runner until
  // it commits: `queueInput` stores the input and delivers it afterwards, and
  // `respondToApprovalRequest` sends its frame afterwards.
  const handlers: BindableOperationHandlers<Effect.Effect<unknown, BindableOperationError>> = {
    "task.update": ({ taskId, ...changes }) => tasks.update({ id: taskId, ...changes }),
    "run.start": (input) => runs.start(input),
    "session.input": ({ sessionId, ...input }) => live.queueInput({ id: sessionId, ...input }),
    "session.respondToApprovalRequest": ({ sessionId, ...decided }) =>
      live.respondToApprovalRequest({ id: sessionId, ...decided }),
    "permission.decide": (input) => permissionRequests.decide(input),
  };

  return BindableOperations.of({
    run: (operation) => Effect.asVoid(dispatchBindableOperation(handlers, operation)),
    describe: yield* buildDescribe,
  });
});

/**
 * The bindable operations, run with the task and run services, `Live` and the
 * Permission Request use case. Describing an answer reads the permission
 * profiles, to name the profile a Permission Request's `profile` answer
 * widens.
 */
export const BindableOperationsLayer: Layer.Layer<
  BindableOperations,
  never,
  SqlClient.SqlClient | TaskService | RunService | Live | PermissionRequests | PermissionProfiles
> = Layer.effect(BindableOperations)(make);
