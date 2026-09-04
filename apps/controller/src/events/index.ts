/**
 * The event log: one append-only table holding pipeline events and audit
 * entries (spec 08). Only the audit writer exists so far.
 */
export {
  AUDIT_KINDS,
  AuditLog,
  AuditLogLayer,
  type AuditEntry,
  type AuditKind,
  type AuditRow,
} from "./audit-log";
