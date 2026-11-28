/**
 * Projects: a way to group information inside Hercule.
 *
 * A project carries no behaviour and two defaults for a new thread in it: the
 * Model Profile it starts on (`modelProfileId`) and the MCP Servers it starts
 * with (`mcpServerIds`). It has no default connection, no
 * status and nothing derived: a task points at one through `projectId`, and a
 * resource joins any number of them. Delete is soft, as it is for a task, and
 * a task keeps its `projectId` when its project is deleted.
 */
import { Schema } from "effect";
import * as HttpApiEndpoint from "effect/http-api/HttpApiEndpoint";
import * as HttpApiGroup from "effect/http-api/HttpApiGroup";
import { Forbidden, Internal, NotFound, Unauthenticated, Validation } from "../errors";
import { Id, Timestamp } from "../ids";
import { McpServerIds } from "./mcp-server";
import { page, pageParams } from "../pagination";
import { Authenticated } from "../security";
import { bounded } from "../strings";

/** The longest project name. */
export const MAX_PROJECT_NAME_LENGTH = 128;

/** The longest project description. Markdown, like a task's. */
export const MAX_PROJECT_DESCRIPTION_LENGTH = 64 * 1024;

const ProjectName = bounded(1, MAX_PROJECT_NAME_LENGTH);
const ProjectDescription = bounded(0, MAX_PROJECT_DESCRIPTION_LENGTH);

export const Project = Schema.Struct({
  id: Id,
  name: ProjectName,
  description: Schema.optionalKey(ProjectDescription),
  /**
   * The Model Profile a new thread in this project starts on. Absent when the
   * project names none, and then a new thread starts on the user's thread
   * default. Deleting the profile removes it from the project.
   */
  modelProfileId: Schema.optionalKey(Id),
  /**
   * The MCP Servers a new Thread in this project starts with, in order. Empty
   * when the project names none. A default only: changing it touches no
   * Thread that exists. Deleting a server removes it from the list.
   */
  mcpServerIds: McpServerIds,
  createdAt: Timestamp,
  updatedAt: Timestamp,
  /** Set by a delete. A deleted project is never returned, so a caller never sees this field. */
  deletedAt: Schema.optionalKey(Timestamp),
});

export type Project = Schema.Schema.Type<typeof Project>;

/** What a project listing may be sorted by. */
export const PROJECT_SORT_FIELDS = ["name", "createdAt", "updatedAt"] as const;

/**
 * The payload of `project.create`. The service decodes it too, so an
 * in-process caller must send the same shape as a request.
 */
export const ProjectCreateInput = Schema.Struct({
  name: ProjectName,
  description: Schema.optionalKey(ProjectDescription),
  /** A Model Profile that exists; any other id is refused `validation`. */
  modelProfileId: Schema.optionalKey(Id),
  /**
   * The MCP Servers a new Thread in the project starts with. Needs
   * `mcp.manage` as well as `project.write`. Refused `validation` when an id
   * is unknown or deleted, is given twice, or when two servers share a name.
   */
  mcpServerIds: Schema.optionalKey(McpServerIds),
});

export type ProjectCreateInput = Schema.Schema.Type<typeof ProjectCreateInput>;

/** The payload of `project.update`. A field left out is not changed. */
export const ProjectUpdateInput = Schema.Struct({
  name: Schema.optionalKey(ProjectName),
  /** `null` removes the description; no other value does. */
  description: Schema.optionalKey(Schema.NullOr(ProjectDescription)),
  /** `null` removes the project's profile; an id that is no profile is refused `validation`. */
  modelProfileId: Schema.optionalKey(Schema.NullOr(Id)),
  /** Replaces the list. Needs `mcp.manage`, and is refused `validation` as on create. */
  mcpServerIds: Schema.optionalKey(McpServerIds),
});

export type ProjectUpdateInput = Schema.Schema.Type<typeof ProjectUpdateInput>;

export const project = HttpApiGroup.make("project")
  .add(
    HttpApiEndpoint.get("query", "/projects", {
      query: pageParams(PROJECT_SORT_FIELDS),
      success: page(Project),
      error: [Unauthenticated, Forbidden, Validation, Internal],
    }),
    HttpApiEndpoint.get("read", "/projects/:id", {
      params: { id: Id },
      success: Project,
      error: [Unauthenticated, Forbidden, Validation, NotFound, Internal],
    }),
    HttpApiEndpoint.post("create", "/projects", {
      payload: ProjectCreateInput,
      success: Project,
      error: [Unauthenticated, Forbidden, Validation, Internal],
    }),
    HttpApiEndpoint.patch("update", "/projects/:id", {
      params: { id: Id },
      payload: ProjectUpdateInput,
      success: Project,
      error: [Unauthenticated, Forbidden, Validation, NotFound, Internal],
    }),
    HttpApiEndpoint.delete("delete", "/projects/:id", {
      params: { id: Id },
      success: Schema.Struct({}),
      error: [Unauthenticated, Forbidden, Validation, NotFound, Internal],
    }),
  )
  .middleware(Authenticated);
