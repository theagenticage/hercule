/**
 * Ingesting events from plugin event sources:
 *
 * - the Ingest Reconciler, the loop that opens an ingest handle for every
 *   Connection that should be ingesting, and closes the rest;
 * - the Ingest Executor, which runs each Connection's ingest on a fiber of
 *   its own for the plugins domain;
 * - the Open Signals port, which reads the signals still open on a Connection
 *   for its event source;
 * - the Entity Observations port, through which an event source reports what a
 *   poll read of External Entities;
 * - the daily prune of External Entities nothing needs.
 */
export { EntityObservationsLayer } from "./entity-observations";
export { EntityPruneInterval, runEntityPruneLoop } from "./entity-prune";
export { IngestExecutorLayer } from "./executor";
export { OpenSignalsLayer } from "./open-signals";
export { IngestReconcileInterval, runIngestReconciler } from "./reconciler";
