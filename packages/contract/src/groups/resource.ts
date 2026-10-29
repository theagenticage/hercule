/**
 * Resources: the durable external things a project works with - a git repo, a
 * folder, a mailbox.
 *
 * A repo is identified by its canonical remote (`host/owner/repo`), not by the
 * way it was written: the scheme, a `.git` suffix, ssh versus https and the
 * case of the host and the path are all ignored, so one repository is one
 * resource however the user wrote it. A folder and a mailbox carry a label and
 * no remote; only a repo is checked out into a workspace.
 *
 * A resource joins any number of projects. A project is only a grouping, so
 * the link is a list on the resource rather than a nested record of its own.
 *
 * Each kind has its own fields, and the service rejects fields a kind has no
 * use for, rather than storing values nothing would ever read:
 *
 * - a repo takes a remote, a setup command and `workspaceInclude`, and no label;
 * - a folder and a mailbox take a label, and none of the other three.
 */
import { Schema } from "effect";
import { MAX_FACT_LENGTH, MAX_LISTED_BRANCHES } from "@hercule/protocol";
import * as HttpApiEndpoint from "effect/http-api/HttpApiEndpoint";
import * as HttpApiGroup from "effect/http-api/HttpApiGroup";
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

/**
 * A remote is one line with no control characters. Its canonical form is
 * printed on the line each session's instructions give a repository, so a
 * line break in it would start a line of its own there.
 */
const Remote = bounded(1, MAX_REMOTE_LENGTH).check(
  Schema.makeFilter((remote: string) =>
    /[\p{C}\u2028\u2029]/u.test(remote)
      ? "a remote is one line, with no control characters"
      : undefined,
  ),
);

const ResourceLabel = bounded(1, MAX_RESOURCE_LABEL_LENGTH);

const SetupCommand = bounded(1, MAX_SETUP_COMMAND_LENGTH);

const ProjectIds = atMost(Id, MAX_RESOURCE_PROJECTS);

export const Resource = Schema.Struct({
  id: Id,
  kind: ResourceKind,
  /** As the user wrote it; null on a folder and a mailbox. */
  remote: Schema.NullOr(Remote),
  /** `host/owner/repo`, lowercased: the identity that two spellings of a remote share. */
  canonicalRemote: Schema.NullOr(Schema.String),
  /** What a folder or a mailbox is called; always null on a repo, which its remote identifies. */
  label: Schema.NullOr(ResourceLabel),
  /** The Connection Hercule acts through for this resource. */
  connectionId: Schema.NullOr(Id),
  /** Run in a fresh checkout once it is ready; always null for anything but a repo. */
  setupCommand: Schema.NullOr(SetupCommand),
  /**
   * Whether a fresh checkout takes what the main workspace's `.workspaceinclude`
   * lists. Always false for anything but a repo, because only a repo is checked out.
   */
  workspaceInclude: Schema.Boolean,
  projectIds: Schema.Array(Id),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});

export type Resource = Schema.Schema.Type<typeof Resource>;

export const RESOURCE_SORT_FIELDS = ["createdAt"] as const;

/**
 * The payload of `resource.create`. The service, not the schema, checks which
 * fields each kind takes (see the top of this file). A schema union per kind
 * would turn the whole payload into one opaque JSON document on the command
 * line.
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

/** The payload of `resource.update`. A field left out is not changed; `null` clears a field. */
export const RESOURCE_UPDATE_FIELDS = {
  remote: Schema.optionalKey(Remote),
  label: Schema.optionalKey(Schema.NullOr(ResourceLabel)),
  connectionId: Schema.optionalKey(Schema.NullOr(Id)),
  setupCommand: Schema.optionalKey(Schema.NullOr(SetupCommand)),
  workspaceInclude: Schema.optionalKey(Schema.Boolean),
  /** The whole list, which replaces the current one. */
  projectIds: Schema.optionalKey(ProjectIds),
} as const;

export const ResourceUpdateInput = closedStruct(RESOURCE_UPDATE_FIELDS);

export type ResourceUpdateInput = Schema.Schema.Type<typeof ResourceUpdateInput>;

export const ResourceFilter = Schema.Struct({
  kind: Schema.optionalKey(ResourceKind),
  projectId: Schema.optionalKey(Id),
});

/** How many branches of each kind `resource.listBranches` returns without being asked for a number. */
export const DEFAULT_MAX_BRANCHES = 50;

/**
 * What `resource.listBranches` lists: the repo's branches on one runner,
 * filtered by `text`. A repository can have tens of thousands of branches, so
 * the answer is always cut to `maxBranches` names of each kind.
 */
export const ResourceBranchFilter = Schema.Struct({
  /** The runner whose main workspace of the repo is read. */
  runnerId: Id,
  /** Keeps the branches whose name contains this text, ignoring letter case. Empty keeps every branch. */
  text: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(MAX_FACT_LENGTH))),
  /** The most branches of each kind to return; `DEFAULT_MAX_BRANCHES` when left out. */
  maxBranches: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: MAX_LISTED_BRANCHES })),
  ),
});

export type ResourceBranchFilter = Schema.Schema.Type<typeof ResourceBranchFilter>;

/**
 * The branches of a repo on one runner, read live from its main workspace.
 * Each list is sorted by the date of the branch's newest commit, newest
 * first.
 */
export const ResourceBranches = Schema.Struct({
  /** The local branches. */
  local: Schema.Array(Schema.String),
  /** The branches of the checkout's remote, named without the remote. */
  remote: Schema.Array(Schema.String),
  /** True when a list was cut to the limit and more branches match the text. */
  more: Schema.Boolean,
  /**
   * Why no branches could be listed: the runner has no ready main workspace
   * of the repo, it is offline or too old, or git failed. Absent when the
   * lists are what the runner found.
   */
  unavailableReason: Schema.optionalKey(Schema.String),
});

export type ResourceBranches = Schema.Schema.Type<typeof ResourceBranches>;

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
    // A runner that cannot answer is not an error: the answer carries the
    // reason, so a menu can show it beside the choices that need no list.
    HttpApiEndpoint.get("listBranches", "/resources/:id/branches", {
      params: { id: Id },
      query: ResourceBranchFilter,
      success: ResourceBranches,
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
