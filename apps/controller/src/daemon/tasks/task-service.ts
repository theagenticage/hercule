/**
 * The Task service with the ports of the tasks domain answered. The tasks
 * domain declares the ports and cannot import the sessions, runs, External
 * Entities and plugins that answer them, so every place that builds the
 * service from its layer joins the two here.
 */
import * as Layer from "effect/Layer";
import { TaskServiceLayer } from "../../tasks";
import { LinkedEntitiesLayer } from "./linked-entities";
import { TaskLinkOwnersLayer } from "./link-owners";

/** Every port the Task service requires, answered. */
export const TaskServicePortsLayer = Layer.mergeAll(TaskLinkOwnersLayer, LinkedEntitiesLayer);

export const TaskServiceWithPortsLayer = TaskServiceLayer.pipe(
  Layer.provide(TaskServicePortsLayer),
);
