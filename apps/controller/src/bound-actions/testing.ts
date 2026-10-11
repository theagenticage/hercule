/**
 * A fake of the `BoundOperations` port, for the tests of a domain that holds
 * Bound Actions.
 *
 * The real port lives in the controller daemon, which a domain's test cannot
 * import. A test that checks the real describe lines, a plugin action, or
 * what an operation really does, runs the controller over HTTP.
 */
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { createValidationError, decodeAnswerOperation, isQualifiedId } from "@hercule/contract";
import { BoundOperations } from "./index";

/**
 * The fake port:
 *
 * - `check` checks a contract operation as the real port does, and refuses a
 *   plugin action, a `connectionId` and a typed reply, which only the real
 *   port can check;
 * - `run` succeeds without doing anything;
 * - `runPluginAction` dies, because `check` never lets a plugin action
 *   through;
 * - `describe` writes each operation's id as its describe line, such as
 *   "run.start".
 */
export const FakeBoundOperationsLayer: Layer.Layer<BoundOperations> = Layer.succeed(
  BoundOperations,
  BoundOperations.of({
    check: (place, operation, field, path) =>
      isQualifiedId(operation.op) || operation.connectionId !== undefined || field !== undefined
        ? Effect.fail(
            createValidationError([
              {
                path: [...path],
                message:
                  "the fake BoundOperations port checks contract operations only; test this over HTTP",
              },
            ]),
          )
        : decodeAnswerOperation(place, operation, [...path, "operation"]),
    run: () => Effect.void,
    runPluginAction: () => Effect.die("the fake BoundOperations port runs no plugin action"),
    describe: (operations) =>
      Effect.succeed(operations.map((operation) => [{ kind: "text", text: operation.op }])),
  }),
);
