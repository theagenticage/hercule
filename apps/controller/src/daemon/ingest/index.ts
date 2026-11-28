/**
 * Ingesting events from plugin event sources:
 *
 * - the Ingest Reconciler, the loop that opens an ingest handle for every
 *   Connection that should be ingesting, and closes the rest;
 * - the Ingest Executor, which runs each Connection's ingest on a fiber of
 *   its own for the plugins domain;
 * - the Open Signals port, which reads the signals still open on a Connection
 *   for its event source;
 * - the Signal Entities port, through which the signals domain reads the
 *   External Entity a signal is about and reports a signal's arrival on it;
 * - the Entity Observations port, through which an event source reports what a
 *   poll read of External Entities;
 * - the loop that gives pending claims a ref;
 * - the daily prune of External Entities nothing needs.
 */
export { ClaimResolverInterval, runClaimResolverLoop } from "./claim-resolver";
export { EntityObservationsLayer } from "./entity-observations";
export { EntityPruneInterval, runEntityPruneLoop } from "./entity-prune";
export { IngestExecutorLayer } from "./executor";
export { OpenSignalsLayer } from "./open-signals";
export { SignalEntitiesLayer } from "./signal-entities";
export { IngestReconcileInterval, runIngestReconciler } from "./reconciler";
