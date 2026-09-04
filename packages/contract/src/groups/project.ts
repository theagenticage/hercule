/**
 * Projects: a way to group information inside Hydra.
 *
 * A project carries no behaviour. It has no default connection, no status and
 * nothing derived: a task points at one through `projectId`, and a resource
 * joins any number of them. Delete is soft, as it is for a task, and a task
 * keeps its `projectId` when the project it names is deleted.
 */
import { Schema } from "effect";
import * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint";
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup";
import { Forbidden, Internal, NotFound, Unauthenticated, Validation } from "../errors";
import { Id, Timestamp } from "../ids";
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
  createdAt: Timestamp,
  updatedAt: Timestamp,
  /** Set by a delete, and so absent from everything a caller can still read. */
  deletedAt: Schema.optionalKey(Timestamp),
});

export type Project = Schema.Schema.Type<typeof Project>;

/** What a project listing may be sorted by. */
export const PROJECT_SORT_FIELDS = ["name", "createdAt", "updatedAt"] as const;

/**
 * What creating a project takes. The service decodes it as well, so an
 * in-process caller is held to the same shape a request is.
 */
export const ProjectCreateInput = Schema.Struct({
  name: ProjectName,
  description: Schema.optionalKey(ProjectDescription),
});

export type ProjectCreateInput = Schema.Schema.Type<typeof ProjectCreateInput>;

/** What editing a project takes. An absent field is left as it was. */
export const ProjectUpdateInput = Schema.Struct({
  name: Schema.optionalKey(ProjectName),
  /** `null` takes the description off again, which nothing else can do. */
  description: Schema.optionalKey(Schema.NullOr(ProjectDescription)),
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
