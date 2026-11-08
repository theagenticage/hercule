/**
 * External Entities: the records of outside things (pull requests, issues,
 * tickets) that plugins report, the Inbox that lists the ones that concern the
 * user, and the relationships between them.
 */
export {
  ClaimResolution,
  ClaimResolutionLayer,
  type ClaimResolutionOutcome,
  type PendingClaim,
} from "./claim-resolution";
export { buildActiveEntityKind } from "./entity-records";
export { ExternalEntityHandoffs, ExternalEntityHandoffsLayer } from "./handoffs";
export { ExternalEntityIngest, ExternalEntityIngestLayer } from "./ingest";
export {
  buildScopedTargetPrefix,
  decodePendingTarget,
  encodePendingTarget,
  PENDING_URL_PREFIX,
  type PendingTarget,
} from "./pending-target";
export {
  externalEntityRepository,
  type ContextRead,
  type ObservedEntity,
  type StoredRecordState,
} from "./repository";
export { ExternalEntityService, ExternalEntityServiceLayer } from "./service";
