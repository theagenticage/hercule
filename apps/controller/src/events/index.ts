/**
 * The event log: one append-only table holding pipeline events and audit
 * entries. The audit writer appends audit entries, the platform event
 * writer appends the events the controller emits about its own state into
 * the pipeline, the Scheduler appends a `cron.tick` for each cron trigger
 * that comes due, and the ingested-event writer appends what event sources
 * emit through a Connection; the service implements `event.query`,
 * `event.read` and `event.emit`, and amends a pipeline event for the
 * enrichment use case in the controller daemon. Beside them are the internal
 * reads of the log, the cursor a durable consumer uses to keep its place, and
 * the catalog of event kinds a trigger can listen for, which `eventKind.query`
 * lists.
 */
export { AUDIT_KINDS, AuditLog, AuditLogLayer, type AuditEntry, type AuditKind } from "./audit-log";
export { EventKindCatalog, type DeclaredEventKindWithConnectionType } from "./catalog";
export { appendCronTickEvent } from "./cron-tick-event";
export { appendIngestedEvent, type IngestedEventToAppend } from "./ingested-event";
export { CRON_TICK_EVENT_KIND, EventKinds, EventKindsLayer, isCoreEventKind } from "./kinds";
export {
  advanceConsumerCursor,
  readConsumerPosition,
  readEventsAfter,
  readLogHead,
  readPipelineEvent,
  readPipelineEventsAfter,
} from "./log";
export {
  PlatformEvents,
  PlatformEventsLayer,
  type PlatformEvent,
  type PlatformEventKind,
} from "./platform-events";
export { decodeAgainstKind, EventService, EventServiceLayer } from "./service";
export { CRON_TICK_SOURCE } from "./sources";
