/**
 * Reads what validating a workflow definition needs, from the database and
 * the plugin host. A save, `workflow.validate`, a run start and the
 * re-validation of the stored workflows all read through it, so they all
 * judge a definition against the same references.
 */
import * as Effect from "effect/Effect";
import type { SqlError } from "effect/sql/SqlError";
import { isId, type WorkflowDefinition, type WorkflowIssues } from "@hercule/contract";
import { agentRepository } from "../agents";
import { connectionRepository } from "../connections";
import { EventKinds } from "../events";
import { PluginHost } from "../plugins";
import { workflowRepository } from "./repository";
import {
  listReferencedAgentIds,
  listReferencedConnectionIds,
  listStartedWorkflowIds,
  validateDefinition,
  type ConnectionParamReferences,
  type ResolvedReferences,
} from "./validation";

/**
 * The ids of the Agents, Connections and stored workflows that one definition
 * refers to. Validating the definition looks them up in the database.
 */
export interface ReferencedIds {
  readonly agentIds: ReadonlyArray<string>;
  readonly connectionIds: ReadonlyArray<string>;
  readonly startedWorkflowIds: ReadonlyArray<string>;
}

/**
 * Returns the ids that `definition` refers to. Throws when the definition
 * does not have the shape the schema gives it, which only a stored
 * definition from an older controller can lack.
 */
export const listReferencedIds = (definition: WorkflowDefinition): ReferencedIds => ({
  agentIds: listReferencedAgentIds(definition),
  connectionIds: listReferencedConnectionIds(definition),
  startedWorkflowIds: listStartedWorkflowIds(definition),
});

/**
 * Builds the functions that read a definition's references, the one that
 * reads the references of many definitions at once, and the one that reads
 * a definition's references and validates it. None of them fails but with
 * `SqlError`.
 */
export const workflowReferences = Effect.gen(function* () {
  const workflows = yield* workflowRepository;
  const agents = yield* agentRepository;
  const connections = yield* connectionRepository;
  const host = yield* PluginHost;
  const eventKinds = yield* EventKinds;

  /**
   * Reads what finding the connection params of `definition` needs: the
   * available actions, and the inputs of the stored workflows its
   * `run.start` steps name.
   */
  const readConnectionParamReferences = (
    definition: WorkflowDefinition,
  ): Effect.Effect<ConnectionParamReferences, SqlError> =>
    Effect.gen(function* () {
      return {
        actions: new Map(
          (yield* host.listActiveWorkflowActions()).map((action) => [action.id, action]),
        ),
        startedWorkflowInputsById: yield* workflows.readInputs(listStartedWorkflowIds(definition)),
      };
    });

  /**
   * Reads what validating every definition whose ids are in `referenced`
   * needs, with one read per kind of reference however many definitions
   * there are: the available actions, event kinds and Connection types, and
   * which of the Agents, Connections and stored workflows they refer to
   * exist. Each definition can be validated against the result, because the
   * validator only looks up the ids its own definition names.
   *
   * An id that is not a valid id is not looked up, so a stored definition of
   * an unexpected shape cannot fail the read for the others. The validator
   * reports such an id as missing.
   */
  const readSharedReferences = (
    referenced: ReadonlyArray<ReferencedIds>,
  ): Effect.Effect<ResolvedReferences, SqlError> =>
    Effect.gen(function* () {
      const collectIds = (pick: (ids: ReferencedIds) => ReadonlyArray<string>) => [
        ...new Set(referenced.flatMap(pick).filter(isId)),
      ];
      return {
        actions: new Map(
          (yield* host.listActiveWorkflowActions()).map((action) => [action.id, action]),
        ),
        startedWorkflowInputsById: yield* workflows.readInputs(
          collectIds((ids) => ids.startedWorkflowIds),
        ),
        eventKinds: new Map(
          (yield* eventKinds.list()).map((eventKind) => [eventKind.kind, eventKind]),
        ),
        agentKindById: yield* agents.readKinds(collectIds((ids) => ids.agentIds)),
        connectionTypeById: yield* connections.readTypes(collectIds((ids) => ids.connectionIds)),
        connectionTypes: new Set(yield* host.listActiveConnectionTypes()),
      };
    });

  /**
   * Reads what validating `definition` needs: the available actions, event
   * kinds and Connection types, and which of the Agents and Connections that
   * the definition refers to exist.
   *
   * A save calls this inside its transaction, so the rows cannot change
   * between the validation and the write.
   */
  const readReferences = (
    definition: WorkflowDefinition,
  ): Effect.Effect<ResolvedReferences, SqlError> =>
    readSharedReferences([listReferencedIds(definition)]);

  /**
   * Reads what `definition` refers to, then validates the definition against
   * it. Returns every error and warning found.
   */
  const readReferencesAndValidate = (
    definition: WorkflowDefinition,
  ): Effect.Effect<WorkflowIssues, SqlError> =>
    Effect.flatMap(readReferences(definition), (references) =>
      validateDefinition(definition, references),
    );

  return {
    readConnectionParamReferences,
    readReferences,
    readSharedReferences,
    readReferencesAndValidate,
  };
});
