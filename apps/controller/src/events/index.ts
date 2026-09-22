/**
 * The event log: one append-only table holding pipeline events and audit
 * entries. The audit writer appends; the service answers `event.query`,
 * `event.read` and `event.emit`, and amends a pipeline event for the
 * enrichment use case in the controller daemon. Beside them are the walks that
 * are not a public read and the cursor a durable consumer keeps its place in.
 */
export {
  AUDIT_KINDS,
  AuditLog,
  AuditLogLayer,
  type AuditEntry,
  type AuditKind,
  type AuditRow,
} from "./audit-log";
export { EventKindCatalog } from "./catalog";
export {
  advanceConsumerCursor,
  readConsumerPosition,
  readEventsAfter,
  readLogHead,
  readPipelineEvent,
  readPipelineEventsAfter,
} from "./log";
export { EventService, EventServiceLayer } from "./service";
