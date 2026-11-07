/**
 * The `entities` feed: reads the issues assigned to the user and reports them
 * to the host as External Entity observations.
 *
 * A poll has two parts:
 *
 * 1. The inventory: one query for the open issues assigned to the user, paged
 *    to the end. Only when every page was read does the poll report anything,
 *    so a failed page, a rate limit or a restart reports nothing and takes
 *    nothing away.
 * 2. The refresh: the host names the issues it wants read although they are
 *    not in the inventory, such as an issue that was completed since. One
 *    batched query reads them all.
 * 3. The context: each issue is reported with what it is part of and what it
 *    links to (`entity-context.ts`), read for many issues per request. Then
 *    the host's wanted projects, initiatives, milestones and teams are read
 *    the same way as wanted issues.
 *
 * The inventory does not use the Connection's watch filters. Those decide
 * which issues become events. The Inbox asks its own question: what is
 * assigned to me.
 */
import { Effect } from "effect";
import type * as HttpClient from "effect/http/HttpClient";
import {
  MAX_ENTITY_OBSERVATIONS,
  PluginError,
  type EntityObservation,
  type IngestEntities,
  type PollResult,
} from "@hercule/plugin-host";
import { readNewestPages, type LinearFailure } from "../api";
import { OPEN_STATE_TYPES } from "../connection-type";
import { ISSUE_KIND } from "../entity-kinds";
import { buildIssueObservation, parseRef } from "../entity-reads";
import type { WorkspaceBlock } from "../kinds";
import { ApiIssue, ISSUE_FRAGMENT } from "../linear-objects";
import {
  buildIssueContextFields,
  buildParentObservation,
  PLACE_READS,
  readIssueContexts,
} from "./entity-context";
import { readIdentity } from "./identity";
import { readIssuesById } from "./issues";

/** How many refs of one kind the poll asks the host for, and reads, each time. */
const WANTED_REFS_PER_KIND = 50;

/**
 * The query that lists the open issues assigned to the user, the most
 * recently updated first. Linear leaves archived and trashed issues out, so
 * an issue that was archived leaves the inventory and the refresh finds it.
 */
const ASSIGNED_ISSUES_QUERY = `query LinearAssignedIssues($filter: IssueFilter, $first: Int, $after: String) {
  issues(filter: $filter, first: $first, after: $after, orderBy: updatedAt) {
    nodes { ...IssueFields }
    pageInfo { hasNextPage endCursor }
  }
}
${ISSUE_FRAGMENT}`;

/** The filter of the inventory: assigned to the user, in an open state. */
const ASSIGNED_FILTER = {
  assignee: { isMe: { eq: true } },
  state: { type: { in: [...OPEN_STATE_TYPES] } },
};

/**
 * Builds the observations of `issues` with the relations and texts of their
 * context, and the partial observations of their parent issues. Reads the
 * context of all the issues in as few requests as it can. Fails as
 * `readIssueContexts` fails.
 */
const buildIssueObservations = (
  authorization: string,
  workspace: WorkspaceBlock,
  userId: string,
  issues: ReadonlyArray<ApiIssue>,
  concerns: ReadonlyArray<"assigned">,
): Effect.Effect<
  { readonly issues: ReadonlyArray<EntityObservation>; readonly parents: Array<EntityObservation> },
  LinearFailure,
  HttpClient.HttpClient
> =>
  Effect.gen(function* () {
    const contexts = yield* readIssueContexts(
      authorization,
      issues.map((issue) => issue.id),
    );
    const parents: Array<EntityObservation> = [];
    const built = issues.map((issue) => {
      const context = contexts.get(issue.id);
      if (context?.parent != null) parents.push(buildParentObservation(context.parent, workspace));
      return {
        ...buildIssueObservation(issue, workspace, userId, concerns),
        ...buildIssueContextFields(issue, workspace, context),
      };
    });
    return { issues: built, parents };
  });

/**
 * Reads the whole inventory of issues, to its last page, and reports it in
 * one `reconcile` call. An inventory longer than the host takes is cut to the
 * most recently updated issues and reported with `complete: false`, so nothing
 * is taken away for the issues left out. Fails as `readNewestPages` fails, on
 * any page, before anything is reported. Returns the parent issues the context read found, as partial
 * observations for the refresh to report.
 */
const reconcileInventory = (
  authorization: string,
  entities: IngestEntities,
  workspace: WorkspaceBlock,
  userId: string,
): Effect.Effect<ReadonlyArray<EntityObservation>, LinearFailure, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const assigned = yield* readNewestPages(
      authorization,
      {
        name: "LinearAssignedIssues",
        text: ASSIGNED_ISSUES_QUERY,
        variables: { filter: ASSIGNED_FILTER },
      },
      "issues",
      ApiIssue,
      MAX_ENTITY_OBSERVATIONS,
    );
    const { issues, parents } = yield* buildIssueObservations(
      authorization,
      workspace,
      userId,
      assigned.items,
      ["assigned"],
    );
    // A complete call is the whole kind: a second complete call for the same
    // kind would unlist what the first one listed.
    yield* entities.reconcile({
      kind: ISSUE_KIND,
      complete: !assigned.hasMore,
      observations: issues,
    });
    return parents;
  });

/**
 * Splits the refs the host wants read into the ids this workspace can read,
 * keyed by id. A ref of another workspace is reported `inaccessible` without
 * a request, since this Connection cannot read it.
 */
const takeReadableRefs = (
  entities: IngestEntities,
  workspace: WorkspaceBlock,
  kind: string,
  wanted: ReadonlyArray<string>,
): Effect.Effect<Map<string, string>, PluginError> =>
  Effect.gen(function* () {
    const readable = new Map<string, string>();
    for (const ref of wanted) {
      const parsed = parseRef(ref);
      if (parsed?.kind === kind && parsed.workspaceId === workspace.id) {
        readable.set(parsed.id, ref);
      } else {
        yield* entities.reportMissing(ref, "inaccessible");
      }
    }
    return readable;
  });

/**
 * Asks the host which issues it wants read now, reads them with their
 * context, and hands over what was found together with `parents`, the parent
 * issues the poll saw. An issue Linear does not return is reported
 * `inaccessible`, never `deleted`: Linear answers the same for an issue that
 * is gone and for one the user may no longer see.
 */
const refreshWantedIssues = (
  authorization: string,
  entities: IngestEntities,
  workspace: WorkspaceBlock,
  userId: string,
  parents: ReadonlyArray<EntityObservation>,
): Effect.Effect<void, LinearFailure, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const wanted = yield* entities.listWanted(ISSUE_KIND, WANTED_REFS_PER_KIND);
    const readable = yield* takeReadableRefs(entities, workspace, ISSUE_KIND, wanted);
    const found =
      readable.size === 0
        ? new Map<string, ApiIssue>()
        : yield* readIssuesById(authorization, [...readable.keys()]);
    const refreshed = yield* buildIssueObservations(
      authorization,
      workspace,
      userId,
      [...found.values()],
      [],
    );
    // A parent that was also read in full is not reported as a place as well.
    const full = new Set(refreshed.issues.map((observation) => observation.ref));
    const places = new Map(
      [...parents, ...refreshed.parents]
        .filter((parent) => !full.has(parent.ref))
        .map((parent) => [parent.ref, parent]),
    );
    // Each ref once, and no more per call than the host takes.
    const observations = [...refreshed.issues, ...places.values()];
    for (let start = 0; start < observations.length; start += MAX_ENTITY_OBSERVATIONS) {
      yield* entities.refresh(observations.slice(start, start + MAX_ENTITY_OBSERVATIONS));
    }
    for (const [id, ref] of readable) {
      if (!found.has(id)) yield* entities.reportMissing(ref, "inaccessible");
    }
  });

/**
 * Reads the projects, initiatives, milestones and teams the host wants, one
 * request for each kind that has any, and hands over what was found. A place
 * Linear does not return stays a claim with no record: it is reported
 * `inaccessible`.
 */
const refreshWantedPlaces = (
  authorization: string,
  entities: IngestEntities,
  workspace: WorkspaceBlock,
): Effect.Effect<void, LinearFailure, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    for (const place of PLACE_READS) {
      const wanted = yield* entities.listWanted(place.kind, WANTED_REFS_PER_KIND);
      const readable = yield* takeReadableRefs(entities, workspace, place.kind, wanted);
      if (readable.size === 0) continue;
      const found = yield* place.read(authorization, workspace, [...readable.keys()]);
      if (found.size > 0) yield* entities.refresh([...found.values()]);
      for (const [id, ref] of readable) {
        if (!found.has(id)) yield* entities.reportMissing(ref, "inaccessible");
      }
    }
  });

/**
 * Polls the `entities` feed once: reports the inventory, then refreshes what
 * the host wants read. Costs one request for the identity, one per page of
 * the inventory, one per 50 issues for their context, and when anything is
 * wanted one lookup per kind of thing (plus the context of wanted issues).
 * Never one request per issue. Fails as `callLinear` does, and with the
 * host's `PluginError` when it refuses what was reported. The inventory is
 * stored before the refresh starts, so a refresh that fails leaves it in
 * place.
 */
export const pollLinearEntities = (
  authorization: string,
  entities: IngestEntities,
): Effect.Effect<PollResult, LinearFailure, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const { workspace, userId } = yield* readIdentity(authorization);
    const parents = yield* reconcileInventory(authorization, entities, workspace, userId);
    yield* refreshWantedIssues(authorization, entities, workspace, userId, parents);
    yield* refreshWantedPlaces(authorization, entities, workspace);
    return {};
  });
