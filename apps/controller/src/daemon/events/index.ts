/**
 * The event pipeline: the event router, the loop that runs it on an interval,
 * and enrichment, which routes an event again after details are added to it.
 *
 * `routing/` holds the routing tables the event router receives and the
 * deliveries that send what those tables write. Each table is the only module
 * that knows both the domain that owns a claim and the domain that handles it.
 */
export { Enrichment, EnrichmentLayer } from "./enrich-event";
export { EventRouter, EventRouterLayer } from "./event-router";
export { EventRoutingInterval, Pipeline, PipelineLayer } from "./pipeline";
