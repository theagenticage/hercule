/**
 * What sits above and beside an issue, as its own reads. The issue fragment
 * names an issue's project, milestone and team but not its parent issue, its
 * initiatives or its attachments, so an issue-only poll cannot keep those
 * current. This file holds:
 *
 * - the issue context read: parent issue and attachments of many issues in
 *   one request, and the `relations` and `texts` an issue observation carries
 *   from it;
 * - the place reads: a project, an initiative, a milestone or a team read by
 *   id for the host's `listWanted` rotation.
 *
 * Nothing here uses the Connection's watch filters.
 */
import { Effect, Schema } from "effect";
import type * as HttpClient from "effect/http/HttpClient";
import {
  MAX_ENTITY_RELATIONS,
  MAX_EVENT_TITLE_LENGTH,
  MAX_EVENT_URL_LENGTH,
  type EntityObservation,
} from "@hercule/plugin-host";
import { callLinear, type LinearFailure } from "../api";
import {
  INITIATIVE_KIND,
  ISSUE_KIND,
  MILESTONE_KIND,
  PROJECT_KIND,
  TEAM_KIND,
} from "../entity-kinds";
import type { WorkspaceBlock } from "../kinds";
import { buildDescription, type ApiIssue } from "../linear-objects";
import { cutName, cutText } from "../text";
import {
  buildInitiativeRef,
  buildIssueRef,
  buildMilestoneRef,
  buildProjectRef,
  buildTeamRef,
} from "./events";

/** How many ids one context or place request reads. It is also the `first` of that request. */
export const CONTEXT_BATCH_SIZE = 50;

/** How many items of one relation a place read takes (a project's initiatives, its teams). */
const RELATION_PAGE_SIZE = 50;

/** A page of a relation, as far as the plugin needs it: whether more follow. */
const MorePages = Schema.Struct({ hasNextPage: Schema.Boolean });

const IdNodes = Schema.Struct({
  nodes: Schema.Array(Schema.Struct({ id: Schema.String })),
  pageInfo: MorePages,
});

// ---------------------------------------------------------------------------
// An issue's context
// ---------------------------------------------------------------------------

/** The query that reads the parent issue and the attachments of issues by id. */
const ISSUE_CONTEXT_QUERY = `query LinearIssueContext($filter: IssueFilter, $first: Int) {
  issues(filter: $filter, first: $first, includeArchived: true) {
    nodes {
      id
      parent { id identifier title }
      attachments(first: ${String(RELATION_PAGE_SIZE)}) { nodes { url } pageInfo { hasNextPage } }
    }
  }
}`;

const ApiIssueContext = Schema.Struct({
  id: Schema.String,
  parent: Schema.NullOr(
    Schema.Struct({ id: Schema.String, identifier: Schema.String, title: Schema.String }),
  ),
  attachments: Schema.Struct({
    nodes: Schema.Array(Schema.Struct({ url: Schema.String })),
    pageInfo: MorePages,
  }),
});

/** An issue's parent and attachments, as `ISSUE_CONTEXT_QUERY` selects them. */
export type ApiIssueContext = Schema.Schema.Type<typeof ApiIssueContext>;

const IssueContextAnswer = Schema.Struct({
  issues: Schema.Struct({ nodes: Schema.Array(ApiIssueContext) }),
});

/**
 * Reads the parent issue and the attachments of the issues `ids`, 50 issues
 * to a request, and returns them by issue id.
 *
 * A request that fails for a reason of Linear's side (an error answer, a
 * shape the plugin does not know) leaves its issues out of the result instead
 * of failing: the caller then reports those issues with `complete: false`, so
 * a failed read takes nothing away. A refused credential and a rate limit
 * still fail, because every later request would fail the same way.
 */
export const readIssueContexts = (
  authorization: string,
  ids: ReadonlyArray<string>,
): Effect.Effect<Map<string, ApiIssueContext>, LinearFailure, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const contexts = new Map<string, ApiIssueContext>();
    for (let start = 0; start < ids.length; start += CONTEXT_BATCH_SIZE) {
      const batch = ids.slice(start, start + CONTEXT_BATCH_SIZE);
      const answer = yield* callLinear(
        authorization,
        {
          name: "LinearIssueContext",
          text: ISSUE_CONTEXT_QUERY,
          variables: { filter: { id: { in: batch } }, first: CONTEXT_BATCH_SIZE },
        },
        IssueContextAnswer,
      ).pipe(Effect.catchTag("PluginError", () => Effect.succeed(undefined)));
      for (const context of answer?.issues.nodes ?? []) contexts.set(context.id, context);
    }
    return contexts;
  });

/** Matches a link a person can open. Other attachment links (an app's own scheme) are no claims. */
const OPENABLE_URL = /^https?:\/\/\S+$/i;

type Relations = NonNullable<EntityObservation["relations"]>;

/**
 * Builds the `relations` and `texts` of an issue observation.
 *
 * - `partOf` holds every parent: the parent issue (when the context was
 *   read), the project, the milestone and the team.
 * - `linkedUrls` holds the attachments' links, each once. It is left out when
 *   the context was not read, because then nothing is known about them.
 * - `complete` is true only when the context was read, every page of the
 *   attachments was, and no link was cut to fit `MAX_ENTITY_RELATIONS`.
 *   Otherwise the host takes no claim away.
 * - `texts` holds the description. An issue with no description reports an
 *   empty text, which clears the hints its old description left.
 */
export const buildIssueContextFields = (
  issue: ApiIssue,
  workspace: WorkspaceBlock,
  context: ApiIssueContext | undefined,
): Pick<Extract<EntityObservation, { partial?: false }>, "relations" | "texts"> => {
  const partOf = [
    ...(context?.parent == null ? [] : [buildIssueRef(workspace, context.parent.id)]),
    ...(issue.project === null ? [] : [buildProjectRef(workspace, issue.project.id)]),
    ...(issue.projectMilestone === null
      ? []
      : [buildMilestoneRef(workspace, issue.projectMilestone.id)]),
    buildTeamRef(workspace, issue.team.id),
  ];
  const urls = [
    ...new Set(
      (context?.attachments.nodes ?? [])
        .map((attachment) => attachment.url)
        .filter((url) => OPENABLE_URL.test(url) && url.length <= MAX_EVENT_URL_LENGTH),
    ),
  ];
  const relations: Relations = {
    complete:
      context !== undefined &&
      !context.attachments.pageInfo.hasNextPage &&
      urls.length <= MAX_ENTITY_RELATIONS,
    partOf,
    linked: [],
    ...(context === undefined ? {} : { linkedUrls: urls.slice(0, MAX_ENTITY_RELATIONS) }),
  };
  const description = buildDescription(issue);
  return {
    relations,
    texts: [
      {
        evidenceKey: "description",
        text: description === null || description.trim() === "" ? "" : description,
        revision: issue.updatedAt,
      },
    ],
  };
};

/**
 * Builds the partial observation of an issue's parent: a title and its
 * identifier, which is all the context read knows. The host draws it as a
 * place until a read gives the whole issue.
 */
export const buildParentObservation = (
  parent: NonNullable<ApiIssueContext["parent"]>,
  workspace: WorkspaceBlock,
): EntityObservation => ({
  kind: ISSUE_KIND,
  ref: buildIssueRef(workspace, parent.id),
  title: cutText(parent.title, MAX_EVENT_TITLE_LENGTH),
  partial: true,
  fields: { key: cutName(parent.identifier) },
});

// ---------------------------------------------------------------------------
// Places
// ---------------------------------------------------------------------------

/** Linear's health words and the status keys of `entity-kinds.ts`. */
const HEALTH_STATUS: Readonly<Record<string, string>> = {
  onTrack: "on-track",
  atRisk: "at-risk",
  offTrack: "off-track",
};

/** Returns the status key of a health word, or nothing when there is none or it is new to the plugin. */
const buildHealthStatus = (health: string | null): { readonly status?: string } => {
  const status = health === null ? undefined : HEALTH_STATUS[health];
  return status === undefined ? {} : { status };
};

/**
 * Returns a day Linear gives without a time, such as `2026-12-01`, as the
 * timestamp the host takes: noon UTC, so the day reads the same in every time
 * zone from UTC-12 to UTC+11. Returns nothing for no date.
 */
const buildTargetDate = (day: string | null): { readonly targetDate?: string } =>
  day !== null && /^\d{4}-\d{2}-\d{2}$/.test(day) ? { targetDate: `${day}T12:00:00.000Z` } : {};

/**
 * Returns the progress Linear reports, as a fraction from 0 to 1. Linear's
 * number is used as it is, only cut to that range. It is never worked out
 * from the issues Hercule can see.
 */
const buildReportedProgress = (progress: number): { readonly progress: { fraction: number } } => ({
  progress: { fraction: Math.min(1, Math.max(0, progress)) },
});

const ApiProject = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  url: Schema.String,
  health: Schema.NullOr(Schema.String),
  progress: Schema.Number,
  targetDate: Schema.NullOr(Schema.String),
  updatedAt: Schema.String,
  initiatives: IdNodes,
  teams: IdNodes,
});

const ApiInitiative = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  url: Schema.String,
  health: Schema.NullOr(Schema.String),
  targetDate: Schema.NullOr(Schema.String),
  updatedAt: Schema.String,
  parentInitiative: Schema.NullOr(Schema.Struct({ id: Schema.String })),
});

const ApiMilestone = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  project: Schema.Struct({ id: Schema.String }),
  progress: Schema.Number,
  targetDate: Schema.NullOr(Schema.String),
  updatedAt: Schema.String,
});

const ApiTeam = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  updatedAt: Schema.String,
});

/** How to read one kind of place by id, and how to turn what was read into an observation. */
export interface PlaceRead {
  /** The unqualified kind word, such as `project`. */
  readonly kind: string;
  /** Reads the places `ids` in one request and returns their observations by id. Fails as `callLinear` does. */
  readonly read: (
    authorization: string,
    workspace: WorkspaceBlock,
    ids: ReadonlyArray<string>,
  ) => Effect.Effect<Map<string, EntityObservation>, LinearFailure, HttpClient.HttpClient>;
}

/**
 * Defines the read of one kind of place. `selection` is the part of the query
 * after the root field's arguments, and the root field is aliased `places`,
 * so every read has the same answer shape. Archived places are read too:
 * an archived project is still a place.
 */
const definePlaceRead = <S extends Schema.Decoder<{ readonly id: string }>>(definition: {
  readonly kind: string;
  readonly queryName: string;
  readonly filterType: string;
  readonly rootField: string;
  readonly selection: string;
  readonly node: S;
  readonly buildObservation: (node: S["Type"], workspace: WorkspaceBlock) => EntityObservation;
}): PlaceRead => {
  const text = `query ${definition.queryName}($filter: ${definition.filterType}, $first: Int) {
  places: ${definition.rootField}(filter: $filter, first: $first, includeArchived: true) {
    nodes { ${definition.selection} }
  }
}`;
  const answer = Schema.Struct({ places: Schema.Struct({ nodes: Schema.Array(definition.node) }) });
  return {
    kind: definition.kind,
    read: (authorization, workspace, ids) =>
      callLinear(
        authorization,
        {
          name: definition.queryName,
          text,
          variables: { filter: { id: { in: ids } }, first: ids.length },
        },
        answer,
      ).pipe(
        Effect.map(
          (data) =>
            new Map(
              data.places.nodes.map((node) => [
                node.id,
                definition.buildObservation(node, workspace),
              ]),
            ),
        ),
      ),
  };
};

/**
 * Collects the parents a place reports, each once. The relations are complete
 * only when Linear had no more parents than were read and none was cut to fit
 * `MAX_ENTITY_RELATIONS`.
 */
const buildPlaceRelations = (
  parents: ReadonlyArray<{ readonly refs: ReadonlyArray<string>; readonly hasMore: boolean }>,
): Relations => {
  const refs = [...new Set(parents.flatMap((relation) => relation.refs))];
  return {
    complete: parents.every((relation) => !relation.hasMore) && refs.length <= MAX_ENTITY_RELATIONS,
    partOf: refs.slice(0, MAX_ENTITY_RELATIONS),
    linked: [],
  };
};

const PROJECT_READ = definePlaceRead({
  kind: PROJECT_KIND,
  queryName: "LinearProjectContext",
  filterType: "ProjectFilter",
  rootField: "projects",
  selection: `id name url health progress targetDate updatedAt
      initiatives(first: ${String(RELATION_PAGE_SIZE)}) { nodes { id } pageInfo { hasNextPage } }
      teams(first: ${String(RELATION_PAGE_SIZE)}) { nodes { id } pageInfo { hasNextPage } }`,
  node: ApiProject,
  buildObservation: (project, workspace) => ({
    kind: PROJECT_KIND,
    ref: buildProjectRef(workspace, project.id),
    title: cutText(project.name, MAX_EVENT_TITLE_LENGTH),
    url: project.url,
    fields: { name: cutName(project.name) },
    concerns: [],
    ...buildHealthStatus(project.health),
    ...buildReportedProgress(project.progress),
    ...buildTargetDate(project.targetDate),
    // A project is part of its initiatives and its teams: two more paths to an issue, not rungs.
    relations: buildPlaceRelations([
      {
        refs: project.initiatives.nodes.map((node) => buildInitiativeRef(workspace, node.id)),
        hasMore: project.initiatives.pageInfo.hasNextPage,
      },
      {
        refs: project.teams.nodes.map((node) => buildTeamRef(workspace, node.id)),
        hasMore: project.teams.pageInfo.hasNextPage,
      },
    ]),
    sourceUpdatedAt: project.updatedAt,
  }),
});

const INITIATIVE_READ = definePlaceRead({
  kind: INITIATIVE_KIND,
  queryName: "LinearInitiativeContext",
  filterType: "InitiativeFilter",
  rootField: "initiatives",
  selection: "id name url health targetDate updatedAt parentInitiative { id }",
  node: ApiInitiative,
  buildObservation: (initiative, workspace) => ({
    kind: INITIATIVE_KIND,
    ref: buildInitiativeRef(workspace, initiative.id),
    title: cutText(initiative.name, MAX_EVENT_TITLE_LENGTH),
    url: initiative.url,
    fields: { name: cutName(initiative.name) },
    concerns: [],
    ...buildHealthStatus(initiative.health),
    ...buildTargetDate(initiative.targetDate),
    relations: buildPlaceRelations([
      {
        refs:
          initiative.parentInitiative === null
            ? []
            : [buildInitiativeRef(workspace, initiative.parentInitiative.id)],
        hasMore: false,
      },
    ]),
    sourceUpdatedAt: initiative.updatedAt,
  }),
});

const MILESTONE_READ = definePlaceRead({
  kind: MILESTONE_KIND,
  queryName: "LinearMilestoneContext",
  filterType: "ProjectMilestoneFilter",
  rootField: "projectMilestones",
  selection: "id name project { id } progress targetDate updatedAt",
  node: ApiMilestone,
  buildObservation: (milestone, workspace) => ({
    kind: MILESTONE_KIND,
    ref: buildMilestoneRef(workspace, milestone.id),
    title: cutText(milestone.name, MAX_EVENT_TITLE_LENGTH),
    fields: { name: cutName(milestone.name) },
    concerns: [],
    ...buildReportedProgress(milestone.progress),
    ...buildTargetDate(milestone.targetDate),
    // A milestone sits under its project. Without this edge it would be a root
    // place, and the Inbox would draw an issue under its milestone as well as
    // under its project.
    relations: buildPlaceRelations([
      { refs: [buildProjectRef(workspace, milestone.project.id)], hasMore: false },
    ]),
    sourceUpdatedAt: milestone.updatedAt,
  }),
});

const TEAM_READ = definePlaceRead({
  kind: TEAM_KIND,
  queryName: "LinearTeamContext",
  filterType: "TeamFilter",
  rootField: "teams",
  selection: "id name updatedAt",
  node: ApiTeam,
  buildObservation: (team, workspace) => ({
    kind: TEAM_KIND,
    ref: buildTeamRef(workspace, team.id),
    title: cutText(team.name, MAX_EVENT_TITLE_LENGTH),
    fields: { name: cutName(team.name) },
    concerns: [],
    sourceUpdatedAt: team.updatedAt,
  }),
});

/** The reads of every kind of place, in the order a poll asks the host for their wanted refs. */
export const PLACE_READS: ReadonlyArray<PlaceRead> = [
  PROJECT_READ,
  INITIATIVE_READ,
  MILESTONE_READ,
  TEAM_READ,
];
