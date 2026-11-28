import type { HerculeClient } from "@hercule/client-core";

/**
 * Removes the Task that taking on or adding the external entity `entityId`
 * made, through `externalEntity.undoTakeOn`. Resolves when the Task is gone.
 * Fails with the controller's reason when the Task was touched since, in
 * which case the Task stays: the caller's undo then fails with that reason.
 */
export const undoAddedTask = async (
  client: HerculeClient,
  entityId: string,
  taskId: string,
): Promise<void> => {
  const outcome = await client.externalEntity.undoTakeOn({
    params: { id: entityId },
    payload: { taskId },
  });
  if (!outcome.undone) {
    throw new Error(outcome.reason ?? "The Task has changed since you made it.");
  }
};
