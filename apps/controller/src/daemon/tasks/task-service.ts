/**
 * The Task service with its Task Link Owners port answered. The tasks domain
 * declares the port and cannot import the sessions and runs that answer it, so
 * every place that builds the service from its layer joins the two here.
 */
import * as Layer from "effect/Layer";
import { TaskServiceLayer } from "../../tasks";
import { TaskLinkOwnersLayer } from "./link-owners";

export const TaskServiceWithLinkOwnersLayer = TaskServiceLayer.pipe(
  Layer.provide(TaskLinkOwnersLayer),
);
