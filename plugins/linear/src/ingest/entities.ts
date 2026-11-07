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
 *
 * The inventory does not use the Connection's watch filters. Those decide
 * which issues become events. The Inbox asks its own question: what is
 * assigned to me.
 */
import { Effect } from "effect";
import type * as HttpClient from "effect/http/HttpClient";
import {
  MAX_ENTITY_OBSERVATIONS,
  type IngestEntities,
  type PollResult,
} from "@hercule/plugin-host";
import { MAX_PAGE_SIZE, readPages, type LinearFailure } from "../api";
import { OPEN_STATE_TYPES } from "../connection-type";
import { ISSUE_KIND } from "../entity-kinds";
import { buildIssueObservation, parseRef } from "../entity-reads";
import type { WorkspaceBlock } from "../kinds";
import { ApiIssue, ISSUE_FRAGMENT } from "../linear-objects";
import { readIdentity } from "./identity";
import { readIssuesById } from "./issues";

/** How many refs of one kind the poll asks the host for, and reads, each time. */
const WANTED_REFS_PER_KIND = 50;

/**
 * The most pages of the inventory a poll reads. They hold exactly the most
 * observations the host takes in one call.
 */
const MAX_INVENTORY_PAGES = MAX_ENTITY_OBSERVATIONS / MAX_PAGE_SIZE;

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
 * Reads the whole inventory of issues and reports it in one `reconcile` call.
 * An inventory longer than the host takes is cut to the most recently updated
 * issues and reported with `complete: false`, so nothing is taken away for
 * the issues left out. Fails as `readPages` fails, before anything is
 * reported.
 */
const reconcileInventory = (
  authorization: string,
  entities: IngestEntities,
  workspace: WorkspaceBlock,
  userId: string,
): Effect.Effect<void, LinearFailure, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const assigned = yield* readPages(
      authorization,
      {
        name: "LinearAssignedIssues",
        text: ASSIGNED_ISSUES_QUERY,
        variables: { filter: ASSIGNED_FILTER },
      },
      "issues",
      ApiIssue,
      MAX_INVENTORY_PAGES,
    );
    // A complete call is the whole kind: a second complete call for the same
    // kind would unlist what the first one listed.
    yield* entities.reconcile({
      kind: ISSUE_KIND,
      complete: !assigned.hasMore,
      observations: assigned.items.map((issue) =>
        buildIssueObservation(issue, workspace, userId, ["assigned"]),
      ),
    });
  });

/**
 * Asks the host which issues it wants read now, reads them in one request,
 * and hands over what was found. An issue Linear does not return is reported
 * `inaccessible`, never `deleted`: Linear answers the same for an issue that
 * is gone and for one the user may no longer see. A ref of another workspace
 * is `inaccessible` without a request, since this Connection cannot read it.
 */
const refreshWantedEntities = (
  authorization: string,
  entities: IngestEntities,
  workspace: WorkspaceBlock,
  userId: string,
): Effect.Effect<void, LinearFailure, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const wanted = yield* entities.listWanted(ISSUE_KIND, WANTED_REFS_PER_KIND);
    const readable = new Map<string, string>();
    for (const ref of wanted) {
      const parsed = parseRef(ref);
      if (parsed?.workspaceId === workspace.id) readable.set(parsed.id, ref);
      else yield* entities.reportMissing(ref, "inaccessible");
    }
    if (readable.size === 0) return;
    const found = yield* readIssuesById(authorization, [...readable.keys()]);
    if (found.size > 0) {
      yield* entities.refresh(
        [...found.values()].map((issue) => buildIssueObservation(issue, workspace, userId, [])),
      );
    }
    for (const [id, ref] of readable) {
      if (!found.has(id)) yield* entities.reportMissing(ref, "inaccessible");
    }
  });

/**
 * Polls the `entities` feed once: reports the inventory, then refreshes what
 * the host wants read. Costs one request for the identity, one per page of
 * the inventory, and one more for the refresh when anything is wanted. Fails
 * as `callLinear` does, and with the host's `PluginError` when it refuses
 * what was reported. The inventory is stored before the refresh starts, so a
 * refresh that fails leaves it in place.
 */
export const pollLinearEntities = (
  authorization: string,
  entities: IngestEntities,
): Effect.Effect<PollResult, LinearFailure, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const { workspace, userId } = yield* readIdentity(authorization);
    yield* reconcileInventory(authorization, entities, workspace, userId);
    yield* refreshWantedEntities(authorization, entities, workspace, userId);
    return {};
  });
