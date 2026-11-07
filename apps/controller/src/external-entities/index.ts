/**
 * External Entities: the records of outside things (pull requests, issues,
 * tickets) that plugins report, the Inbox that lists the ones that concern the
 * user, and the relationships between them.
 */
export { ExternalEntityIngest, ExternalEntityIngestLayer } from "./ingest";
export { externalEntityRepository, type ContextRead, type ObservedEntity } from "./repository";
export { ExternalEntityService, ExternalEntityServiceLayer } from "./service";
