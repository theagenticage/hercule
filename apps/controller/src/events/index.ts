/**
 * The event log: one append-only table holding pipeline events and audit
 * entries. The audit writer appends; the reader answers `event.query` and
 * `event.read`.
 */
export {
  AUDIT_KINDS,
  AuditLog,
  AuditLogLayer,
  type AuditEntry,
  type AuditKind,
  type AuditRecord,
  type AuditRow,
} from "./audit-log";
export { eventsAfter, headOfLog } from "./log";
export { EventService, EventServiceLayer } from "./reader";
