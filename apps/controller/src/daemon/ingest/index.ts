/**
 * Ingesting events from plugin event sources:
 *
 * - the Ingest Reconciler, the loop that opens an ingest handle for every
 *   Connection that should be ingesting, and closes the rest;
 * - the Ingest Executor, which runs each Connection's ingest on a fiber of
 *   its own for the plugins domain;
 * - the Open Signals port, which reads the signals still open on a Connection
 *   for its event source.
 */
export { IngestExecutorLayer } from "./executor";
export { OpenSignalsLayer } from "./open-signals";
export { IngestReconcileInterval, runIngestReconciler } from "./reconciler";
