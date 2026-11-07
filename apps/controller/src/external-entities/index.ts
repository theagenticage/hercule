/**
 * External Entities: the records of outside things (pull requests, issues,
 * tickets) that plugins report, the Inbox that lists the ones that concern the
 * user, and the relationships between them.
 */
export { announceEntityChanges } from "./announce";
export { ExternalEntityIngest, ExternalEntityIngestLayer } from "./ingest";
export { relationClaimRepository, type AncestorWalk } from "./relation-claims";
export { externalEntityRepository } from "./repository";
export { chooseStageForEntity, ExternalEntityService, ExternalEntityServiceLayer } from "./service";
