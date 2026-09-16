/**
 * Resources: the durable external things - repos, folders, mailboxes - that
 * projects work with and workspaces are checked out from.
 */
export { canonicalRemoteOf, isClonableRemote, repoNameOf } from "./remote";
export {
  isCheckedOut,
  NOT_CHECKED_OUT,
  resourceRepository,
  type StoredRepo,
  type StoredResource,
} from "./repository";
export {
  ResourceService,
  ResourceServiceLayer,
  type Identified,
  type QueryInput,
  type ResourcePage,
  type UpdateInput,
} from "./service";
