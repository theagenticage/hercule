/**
 * The event log: one append-only table holding pipeline events and audit
 * entries. The audit writer appends; the service answers `event.query`,
 * `event.read` and `event.emit`.
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
export { eventsAfter, headOfLog } from "./log";
export { EventService, EventServiceLayer } from "./service";
