import * as Layer from "effect/Layer";
import { EventKindsLayer } from "../../events";
import { EventKindCatalogLayer } from "../../plugins";
import { WorkflowServiceLayer } from "../../workflows";
import { WorkflowEntitiesLayer } from "./entities";
import { WorkflowRunsLayer } from "./runs";
import { WorkflowSignalsLayer } from "./signals";

/**
 * Provides the workflow service with the ports it needs from other domains
 * answered, and the list of event kinds it validates each trigger against,
 * which is the same list `eventKind.query` returns. The workflows domain
 * cannot import the events and plugins domains' catalogs, the runs domain, the
 * signals domain or the entities domain, so the controller daemon joins them.
 * The HTTP routes and the boot step that installs the shipped workflows share
 * this one wiring.
 */
export const WorkflowServiceWithPortsLayer = WorkflowServiceLayer.pipe(
  Layer.provide(EventKindsLayer.pipe(Layer.provide(EventKindCatalogLayer))),
  Layer.provide(WorkflowRunsLayer),
  Layer.provide(WorkflowSignalsLayer),
  Layer.provide(WorkflowEntitiesLayer),
);
