/**
 * Resources: the durable external things a project works with - a git repo, a
 * folder, a mailbox.
 *
 * A repo is identified by its canonical remote (`host/owner/repo`), not by the
 * way it was spelled: the scheme, a `.git` suffix, ssh-versus-https and the
 * case of the host and the path all fall away, so one repository is one
 * resource however the user wrote it. A folder and a mailbox carry a label and
 * no remote; only a repo is checked out into a workspace.
 *
 * A resource joins any number of projects, and a project is a grouping and
 * nothing else, so the join is a list on the resource rather than a nested
 * record of its own.
 */
import { Schema } from "effect";
import * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint";
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup";
import { closedStruct } from "../closed";
import {
  Conflict,
  Forbidden,
  Internal,
  InvalidState,
  NotFound,
  Unauthenticated,
  Validation,
} from "../errors";
import { Id, Timestamp } from "../ids";
import { page, pageParams } from "../pagination";
import { Authenticated } from "../security";
import { atMost, bounded } from "../strings";

/** The longest remote URL a resource may carry. */
export const MAX_REMOTE_LENGTH = 512;

/** The longest label a folder or a mailbox may carry. */
export const MAX_RESOURCE_LABEL_LENGTH = 128;

/** The longest setup command; it is a command line, not a script. */
export const MAX_SETUP_COMMAND_LENGTH = 1024;

/** The most projects one resource may be filed under at once. */
export const MAX_RESOURCE_PROJECTS = 64;

/** What a resource is. Only a repo is checked out; the other two are records. */
export const RESOURCE_KINDS = ["repo", "folder", "mailbox"] as const;

export const ResourceKind = Schema.Literals(RESOURCE_KINDS);

export type ResourceKind = Schema.Schema.Type<typeof ResourceKind>;

const Remote = bounded(1, MAX_REMOTE_LENGTH);

const ResourceLabel = bounded(1, MAX_RESOURCE_LABEL_LENGTH);

const SetupCommand = bounded(1, MAX_SETUP_COMMAND_LENGTH);

const ProjectIds = atMost(Id, MAX_RESOURCE_PROJECTS);

export const Resource = Schema.Struct({
  id: Id,
  kind: ResourceKind,
  /** As the user wrote it; null on a folder and a mailbox. */
  remote: Schema.NullOr(Remote),
  /** `host/owner/repo`, lowercased: the identity two spellings share. */
  canonicalRemote: Schema.NullOr(Schema.String),
  /** What to call it where the remote does not say; null on a repo. */
  label: Schema.NullOr(ResourceLabel),
  /** The Connection Hydra acts through for this resource. */
  connectionId: Schema.NullOr(Id),
  /** Run in a fresh checkout once it stands. */
  setupCommand: Schema.NullOr(SetupCommand),
  /** Whether a fresh checkout takes what the primary's `.workspaceinclude` lists. */
  workspaceInclude: Schema.Boolean,
  projectIds: Schema.Array(Id),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});

export type Resource = Schema.Schema.Type<typeof Resource>;

export const RESOURCE_SORT_FIELDS = ["createdAt"] as const;

/**
 * What creating one takes. Which fields a kind requires is the service's to
 * say: a repo needs a remote and no label, a folder and a mailbox the reverse,
 * and a schema union would make every field of it one opaque document on a
 * command line.
 */
export const ResourceCreateInput = closedStruct({
  kind: ResourceKind,
  remote: Schema.optionalKey(Remote),
  label: Schema.optionalKey(ResourceLabel),
  connectionId: Schema.optionalKey(Id),
  setupCommand: Schema.optionalKey(SetupCommand),
  /** On unless it is turned off. */
  workspaceInclude: Schema.optionalKey(Schema.Boolean),
  projectIds: Schema.optionalKey(ProjectIds),
});

export type ResourceCreateInput = Schema.Schema.Type<typeof ResourceCreateInput>;

/** What editing one takes. An absent field is left as it was; `null` clears one. */
export const RESOURCE_UPDATE_FIELDS = {
  remote: Schema.optionalKey(Remote),
  label: Schema.optionalKey(Schema.NullOr(ResourceLabel)),
  connectionId: Schema.optionalKey(Schema.NullOr(Id)),
  setupCommand: Schema.optionalKey(Schema.NullOr(SetupCommand)),
  workspaceInclude: Schema.optionalKey(Schema.Boolean),
  /** The whole list, replaced: the join rows follow what it names. */
  projectIds: Schema.optionalKey(ProjectIds),
} as const;

export const ResourceUpdateInput = closedStruct(RESOURCE_UPDATE_FIELDS);

export type ResourceUpdateInput = Schema.Schema.Type<typeof ResourceUpdateInput>;

export const ResourceFilter = Schema.Struct({
  kind: Schema.optionalKey(ResourceKind),
  projectId: Schema.optionalKey(Id),
});

export const resource = HttpApiGroup.make("resource")
  .add(
    HttpApiEndpoint.get("query", "/resources", {
      query: Schema.Struct({
        ...ResourceFilter.fields,
        ...pageParams(RESOURCE_SORT_FIELDS).fields,
      }),
      success: page(Resource),
      error: [Unauthenticated, Forbidden, Validation, Internal],
    }),
    HttpApiEndpoint.get("read", "/resources/:id", {
      params: { id: Id },
      success: Resource,
      error: [Unauthenticated, Forbidden, Validation, NotFound, Internal],
    }),
    HttpApiEndpoint.post("create", "/resources", {
      payload: ResourceCreateInput,
      success: Resource,
      error: [Unauthenticated, Forbidden, Validation, Conflict, Internal],
    }),
    HttpApiEndpoint.patch("update", "/resources/:id", {
      params: { id: Id },
      payload: ResourceUpdateInput,
      success: Resource,
      error: [Unauthenticated, Forbidden, Validation, NotFound, Conflict, Internal],
    }),
    HttpApiEndpoint.delete("delete", "/resources/:id", {
      params: { id: Id },
      success: Schema.Struct({}),
      error: [Unauthenticated, Forbidden, Validation, NotFound, InvalidState, Internal],
    }),
  )
  .middleware(Authenticated);
