/**
 * The `repos` feed: the life of every issue and pull request in the watched
 * repositories, found by diffing what GitHub lists now against a snapshot of
 * what it listed before.
 *
 * Per repository and poll, the requests are:
 *
 * 1. `GET /repos/{o}/{r}/issues?state=all&sort=updated&direction=asc&since=<cursor>`,
 *    with the last ETag. It lists issues and pull requests updated since the
 *    last poll, oldest update first. `since` includes the cursor's own
 *    second, so the listing repeats the items updated in that second, and
 *    every item listed is diffed again. GitHub's `updated_at` counts whole
 *    seconds, so an item can change twice in one second without its
 *    `updated_at` moving; a diff that finds nothing new emits nothing. A
 *    repository where nothing changed answers 304, which costs no quota.
 * 2. For each pull request diffed: `GET .../pulls/{n}/reviews`, for new
 *    reviews, and, when it is open or was just closed, `GET .../pulls/{n}`,
 *    for its head commit, its review requests and who merged it. When the
 *    review requests to the user or their teams changed,
 *    `GET .../issues/{n}/events` too, for who asked and when.
 * 3. When the listing held any item, or the last poll's comment listing
 *    stopped at its page limit: one
 *    `GET /repos/{o}/{r}/issues/comments?since=<cursor>` for the whole
 *    repository.
 *
 * Two limits keep a poll within the host's time limit, so that a backlog,
 * such as hundreds of pull requests closed while the controller was down, or
 * twenty repositories linked at once that all need a baseline, cannot make
 * every poll run out of time and never save its progress:
 *
 * - One repository diffs a limited number of items per poll. It stops at the
 *   end of a second, after the limit is reached: the cursor and the snapshot
 *   cover only the items it diffed, and the next poll goes on from there. A
 *   poll that stopped early, or whose listing stopped at its page limit,
 *   keeps no ETag, because a 304 on the next poll would hide the items it
 *   did not reach. Comments are still read for the whole repository, so a
 *   comment on an item past the stop is emitted now, counted as new from the
 *   cursor.
 * - One poll sends a limited number of requests across the watch list. Once
 *   they are spent, the poll finishes the repository it is on and stops. The
 *   next poll starts with the repository after the last one polled, so every
 *   repository gets its turn. A repository that waits is polled later, not
 *   skipped: nothing it holds is lost, so the user is not told.
 *
 * The snapshot holds every open item and every item updated in the seven
 * days before the cursor, so its size follows the repository's recent work,
 * not its history. An item missing from the snapshot that existed before
 * the last poll was closed then, so when it shows up open it may have been
 * reopened; its `state_reason` tells.
 *
 * A comment or a review is new when it was created at or after the item's
 * snapshot, or at or after the cursor for an item with no snapshot.
 * Comparing with the item's own snapshot, rather than the cursor, keeps a
 * comment that was created in the cursor's second on another item. "At or
 * after" keeps one created in the snapshot's own second too; its dedup key
 * is its id, so seeing it again in the next poll writes nothing. A snapshot
 * the baseline recorded is the exception: the baseline emitted nothing, so
 * what is in its second existed before the feed started, and only a comment
 * or review strictly after it is new. The snapshot keeps that mark until the
 * item's `updated_at` moves. The price: a comment or review created in the
 * baseline's own second, just after the baseline ran, is never emitted.
 *
 * The keys of the events a diff finds hold the snapshot's `updatedAt`: the
 * state the diff started from. A poll that emitted its events but failed
 * before saving the snapshot diffs from the same snapshot next time and
 * builds the same keys, so the host writes each event once. When the item
 * changed again in between, a label or assignee change that grew holds a
 * different digest and is emitted again with the newer change in it, so
 * nothing is lost. The one key without a snapshot is `reopened` for an item
 * missing from it, which holds the item's own `updated_at`.
 */
import { Effect, Option, Schema } from "effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import type { IngestContext, PollResult } from "@hercule/plugin-host";
import { isUserAccount, type GithubIdentity } from "../identity";
import { buildItemEvent, buildItemPlace, type GithubItem } from "../subject";
import {
  emitCommentEvents,
  emitReviewEvent,
  emitReviewRequestEvents,
  isAtOrAfter,
  type ActivityPoll,
} from "./activity";
import { computeDigest } from "./digest";
import { ListedComment, ListedIssue, ListedPull, ListedReview } from "./feed-objects";
import { pollFollowedItems } from "./followed";
import {
  decodeGithubValue,
  fetchFeedResponse,
  fetchListing,
  readGithubObject,
  truncateRaw,
  type FeedError,
} from "./requests";
import { pollWatchedRepos } from "./state";
import { buildTeamName, readUserTeams } from "./teams";

/** What the snapshot keeps of one issue or pull request: only what a diff compares. */
const ItemSnapshot = Schema.Struct({
  pullRequest: Schema.Boolean,
  state: Schema.String,
  labels: Schema.Array(Schema.String),
  assignees: Schema.Array(Schema.String),
  updatedAt: Schema.String,
  /** The head commit of an open pull request, to tell when a new one was pushed. */
  headSha: Schema.optionalKey(Schema.String),
  /**
   * True when the baseline recorded this item and its `updated_at` has not
   * moved since. Nothing was emitted for the item's update second then, so
   * a comment or review from that second is not new.
   */
  fromBaseline: Schema.optionalKey(Schema.Boolean),
  /**
   * The reviews an open pull request asks of the user and their teams:
   * `you`, and `team:<org>/<slug>` for each team, sorted. A change in it
   * makes the poll read the pull request's history for the requests. Absent
   * for an issue, and for a snapshot an older version of this plugin wrote,
   * which counts as no change.
   */
  reviewRequests: Schema.optionalKey(Schema.Array(Schema.String)),
});

type ItemSnapshot = Schema.Schema.Type<typeof ItemSnapshot>;

/**
 * Where the next poll resumes reading comments, after a comment listing
 * stopped at its page limit.
 */
const PendingComments = Schema.Struct({
  /** The `updated_at` of the last comment read; the listing is sorted by it. */
  since: Schema.String,
  /** The cursor of the poll that stopped. A comment created at or after it is new. */
  createdAfter: Schema.optionalKey(Schema.String),
});

type PendingComments = Schema.Schema.Type<typeof PendingComments>;

/** What the feed keeps between polls for one repository. */
const RepoState = Schema.Struct({
  /**
   * The newest `updated_at` seen, which the next listing asks from. Absent
   * only for a repository that had no issues at all when it was first polled.
   */
  cursor: Schema.optionalKey(Schema.String),
  /** The ETag of the last listing, sent back as `If-None-Match`. */
  etag: Schema.optionalKey(Schema.String),
  /** The snapshot, keyed by issue or pull request number. */
  items: Schema.Record(Schema.String, ItemSnapshot),
  /** Present while comments are left to read from a listing that stopped at its page limit. */
  pendingComments: Schema.optionalKey(PendingComments),
});

type RepoState = Schema.Schema.Type<typeof RepoState>;

/**
 * The most pages of the issue listing one poll fetches, 100 items each. The
 * listing runs oldest first and the cursor stops at the last item read, so
 * whatever is beyond is read by the next poll.
 */
const MAX_LISTING_PAGES = 10;

/**
 * How many issues and pull requests one poll diffs in one repository. A
 * repository diffs this many and then finishes the second it is in, so it
 * can diff a few more. Exported for the tests.
 */
export const MAX_ITEMS_PER_REPO = 50;

/**
 * How many requests one poll sends to GitHub before it stops starting
 * repositories. Exported for the tests.
 *
 * The host stops a poll after 300 seconds, and a GitHub request takes about
 * half a second. The repository a poll is on when the budget runs out still
 * finishes, so a poll sends at most this budget plus one repository's worst
 * case:
 *
 * - a baseline: 1 request for the newest item, then up to 50 pages each of
 *   open issues, closed issues and open pull requests, 151 in all;
 * - a later poll: up to 10 listing pages; for each of `MAX_ITEMS_PER_REPO`
 *   pull requests, the pull request, its reviews and, when its review
 *   requests changed, its history; and up to 10 comment pages: 170 in all
 *   when each review and history listing is one page.
 *
 * So the watch list costs at most 100 + 170 = 270 requests. The followed
 * items after it cost at most about 82 more (see `followed.ts`), so a poll
 * sends about 350 requests, about 175 seconds, and has room to spare for
 * slow answers. The one count without a fixed limit is the items a
 * repository diffs past `MAX_ITEMS_PER_REPO` to finish a second, and the
 * listing's 1,000 items bound those.
 */
export const MAX_REQUESTS_PER_POLL = 100;

/**
 * The most pages a first poll reads of each baseline listing, 100 items
 * each. An item beyond that is not in the snapshot, so its first change is
 * not diffed: it is recorded, and only later changes emit.
 */
const MAX_BASELINE_PAGES = 50;

/**
 * The most pages of reviews or comments one poll reads for one item or
 * repository. A comment listing that has more is resumed by the next poll.
 */
const MAX_DETAIL_PAGES = 10;

/** How long a closed item stays in the snapshot, so a label added just after closing is still seen. */
const CLOSED_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/** One event a diff found, before the subject, refs and URL are added. */
interface ItemChange {
  readonly kind: string;
  readonly dedupKey: string;
  readonly occurredAt: string;
  readonly title: string;
  readonly author: string | null;
  readonly fields?: Readonly<Record<string, unknown>>;
}

/** Returns the values that are not in `reference`, sorted. */
const listMissingFrom = (
  values: ReadonlyArray<string>,
  reference: ReadonlyArray<string>,
): Array<string> => values.filter((value) => !reference.includes(value)).sort();

/** Checks whether ISO 8601 timestamp `time` is strictly after `start`. An absent start is before everything. */
const isAfter = (time: string, start: string | undefined): boolean =>
  start === undefined || Date.parse(time) > Date.parse(start);

/** Returns the label names of an issue. */
const readLabels = (issue: ListedIssue): Array<string> => issue.labels.map((label) => label.name);

/** Returns the logins of an issue's assignees. */
const readAssignees = (issue: ListedIssue): Array<string> =>
  (issue.assignees ?? []).map((user) => user.login);

/** Describes an issue from the listing as the item the subject block is built from. */
const buildIssueItem = (repo: string, issue: ListedIssue): GithubItem => ({
  repo,
  kind: issue.pull_request === undefined ? "issue" : "pr",
  number: issue.number,
  title: issue.title,
  ...(issue.user === null ? {} : { author: issue.user.login }),
  state: issue.state,
});

/**
 * Checks whether an item missing from the snapshot was created since the
 * cursor, which makes it new rather than an old item the snapshot let go of.
 */
const isNewItem = (
  issue: ListedIssue,
  previous: ItemSnapshot | undefined,
  cursor: string | undefined,
): boolean => previous === undefined && isAtOrAfter(issue.created_at, cursor);

/**
 * Returns the time from which a comment or review on an item is new:
 *
 * - the item's snapshot;
 * - one second after it, when the baseline recorded the snapshot, because
 *   whatever was there in that second existed before the feed started;
 * - the cursor, for an old item with no snapshot;
 * - undefined for a new item, whose every comment and review is new.
 *
 * Adding one second means "strictly after" because GitHub's timestamps count
 * whole seconds.
 */
const computeNewActivityStart = (
  issue: ListedIssue,
  previous: ItemSnapshot | undefined,
  cursor: string | undefined,
): string | undefined => {
  if (previous === undefined) return isNewItem(issue, previous, cursor) ? undefined : cursor;
  if (previous.fromBaseline !== true) return previous.updatedAt;
  return new Date(Date.parse(previous.updatedAt) + 1000).toISOString();
};

/**
 * Lists the events one issue or pull request produces, by comparing it with
 * its snapshot from the last poll. `cursor` is where the last poll's listing
 * ended.
 *
 * - Not in the snapshot and created since the cursor: it is new. It is
 *   `opened`, and compared with an empty open item, so labels, assignees and
 *   a close that came with it emit too.
 * - Not in the snapshot and older: it was closed at some point and the
 *   snapshot let go of it, or it lay beyond the first poll's page limit, or
 *   it was moved here from another repository. An open issue whose
 *   `state_reason` is `reopened` is `reopened`; anything else emits nothing,
 *   because its labels and assignees before are not known.
 * - In the snapshot: a close is `closed`, or `merged` for a pull request with
 *   a merge time; a reopen is `reopened` for an issue; labels added or
 *   removed are one `labeled`; new assignees of an issue are one `assigned`.
 *
 * The plugin declares no kind for a pull request that was reopened or
 * assigned, and none for an unassignment, so those changes emit nothing.
 * `mergedBy` is the login of who merged a pull request, when it is known.
 */
const listItemChanges = (
  repo: string,
  issue: ListedIssue,
  previous: ItemSnapshot | undefined,
  cursor: string | undefined,
  mergedBy: string | null,
): ReadonlyArray<ItemChange> => {
  const kind = issue.pull_request === undefined ? "issue" : "pr";
  const noun = kind === "pr" ? "Pull request" : "Issue";
  const item = buildItemPlace({ repo, number: issue.number });
  const isNew = isNewItem(issue, previous, cursor);
  if (previous === undefined && !isNew) {
    // `state_reason` stays `reopened` for as long as the issue is open, so an
    // issue reopened long ago and missing from the snapshot for another
    // reason emits a late `reopened` too. That is rarer than the reopen of an
    // issue closed more than seven days ago, which this catches.
    const reopened =
      kind === "issue" && issue.state === "open" && issue.state_reason === "reopened";
    return reopened
      ? [
          {
            kind: "github.issue.reopened",
            dedupKey: `issue.reopened:${item}:${issue.updated_at}`,
            occurredAt: issue.updated_at,
            title: `Issue ${item} was reopened`,
            author: null,
          },
        ]
      : [];
  }
  const before: Pick<ItemSnapshot, "state" | "labels" | "assignees" | "updatedAt"> = previous ?? {
    state: "open",
    labels: [],
    assignees: [],
    updatedAt: issue.created_at,
  };
  // Every key of a diff holds the state it started from; see the header comment.
  const diffed = `${item}:${before.updatedAt}`;
  const changes: Array<ItemChange> = [];

  if (isNew) {
    changes.push({
      kind: `github.${kind}.opened`,
      dedupKey: `${kind}.opened:${item}`,
      occurredAt: issue.created_at,
      title: `${issue.user?.login ?? "Someone"} opened ${item}: ${issue.title}`,
      author: issue.user?.login ?? null,
    });
  }
  if (kind === "issue" && before.state === "closed" && issue.state === "open") {
    changes.push({
      kind: "github.issue.reopened",
      dedupKey: `issue.reopened:${diffed}`,
      occurredAt: issue.updated_at,
      title: `Issue ${item} was reopened`,
      author: null,
    });
  }
  const labels = readLabels(issue);
  const added = listMissingFrom(labels, before.labels);
  const removed = listMissingFrom(before.labels, labels);
  if (added.length > 0 || removed.length > 0) {
    // A key holds a digest of the names, not the names: twenty long label
    // names would not fit the host's 200 characters.
    const change = computeDigest([
      ...added.map((name) => `+${name}`),
      ...removed.map((name) => `-${name}`),
    ]);
    changes.push({
      kind: `github.${kind}.labeled`,
      dedupKey: `${kind}.labeled:${diffed}:${change}`,
      occurredAt: issue.updated_at,
      title: `Labels changed on ${item}: ${[...added.map((name) => `+${name}`), ...removed.map((name) => `-${name}`)].join(" ")}`,
      author: null,
      fields: { added, removed },
    });
  }
  const assigned = listMissingFrom(readAssignees(issue), before.assignees);
  if (kind === "issue" && assigned.length > 0) {
    changes.push({
      kind: "github.issue.assigned",
      dedupKey: `issue.assigned:${diffed}:${computeDigest(assigned)}`,
      occurredAt: issue.updated_at,
      title: `Issue ${item} was assigned to ${assigned.join(", ")}`,
      author: null,
    });
  }
  if (before.state === "open" && issue.state === "closed") {
    const closedAt = issue.closed_at ?? issue.updated_at;
    const mergedAt = issue.pull_request?.merged_at ?? null;
    changes.push(
      mergedAt === null
        ? {
            kind: `github.${kind}.closed`,
            dedupKey: `${kind}.closed:${item}:${closedAt}`,
            occurredAt: closedAt,
            title: `${noun} ${item} was closed`,
            author: null,
          }
        : {
            kind: "github.pr.merged",
            dedupKey: `pr.merged:${item}`,
            occurredAt: mergedAt,
            title:
              mergedBy === null ? `Pull request ${item} was merged` : `${mergedBy} merged ${item}`,
            author: mergedBy,
          },
    );
  }
  return changes;
};

/**
 * Records where a newly watched repository stands and emits nothing. The
 * cursor is the newest update. The snapshot holds every open item, every
 * item updated in the seven days before the cursor, and the newest item,
 * with the head commit of each open pull request: the same items a later
 * poll keeps, so the first poll after this one diffs like any other.
 */
const baselineRepo = (
  poll: ActivityPoll,
): Effect.Effect<RepoState, FeedError, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const path = `/repos/${poll.repo}`;
    const newest = yield* fetchFeedResponse({
      method: "GET",
      path: `${path}/issues`,
      token: poll.token,
      query: { state: "all", sort: "updated", direction: "desc", per_page: "1" },
    });
    const [latest] = yield* decodeGithubValue(
      Schema.Array(ListedIssue),
      newest.body,
      "the newest issue",
    );
    if (latest === undefined) return { items: {} };
    const retainedSince = new Date(
      Date.parse(latest.updated_at) - CLOSED_RETENTION_MS,
    ).toISOString();
    const open = yield* fetchListing(
      {
        method: "GET",
        path: `${path}/issues`,
        token: poll.token,
        query: { state: "open", per_page: "100" },
      },
      MAX_BASELINE_PAGES,
    );
    const closed = yield* fetchListing(
      {
        method: "GET",
        path: `${path}/issues`,
        token: poll.token,
        query: {
          state: "closed",
          sort: "updated",
          direction: "desc",
          since: retainedSince,
          per_page: "100",
        },
      },
      MAX_BASELINE_PAGES,
    );
    const pulls = yield* fetchListing(
      {
        method: "GET",
        path: `${path}/pulls`,
        token: poll.token,
        query: { state: "open", per_page: "100" },
      },
      MAX_BASELINE_PAGES,
    );
    const issues = yield* decodeGithubValue(
      Schema.Array(ListedIssue),
      [...closed.items, ...open.items],
      "issues",
    );
    const heads = yield* decodeGithubValue(
      Schema.Array(ListedPull),
      pulls.items,
      "open pull requests",
    );
    const openPulls = new Map(heads.map((pull) => [pull.number, pull]));
    const items: Record<string, ItemSnapshot> = {};
    for (const issue of [...issues, latest]) {
      const pull = openPulls.get(issue.number);
      items[String(issue.number)] = buildItemSnapshot(issue, {
        ...(pull === undefined
          ? {}
          : { headSha: pull.head.sha, reviewRequests: readReviewRequests(poll, pull) }),
        fromBaseline: true,
      });
    }
    return { cursor: latest.updated_at, items };
  });

/** What an item's snapshot keeps beside what the issue listing holds. */
interface SnapshotExtras {
  readonly headSha?: string | undefined;
  readonly reviewRequests?: ReadonlyArray<string> | undefined;
  readonly fromBaseline: boolean;
}

/**
 * Builds an item's snapshot from the listing, with the head commit and the
 * review requests of a pull request when they are known, marked
 * `fromBaseline` when `extras.fromBaseline` is true.
 */
const buildItemSnapshot = (issue: ListedIssue, extras: SnapshotExtras): ItemSnapshot => ({
  pullRequest: issue.pull_request !== undefined,
  state: issue.state,
  labels: readLabels(issue),
  assignees: readAssignees(issue),
  updatedAt: issue.updated_at,
  ...(extras.headSha === undefined ? {} : { headSha: extras.headSha }),
  ...(extras.fromBaseline ? { fromBaseline: true } : {}),
  ...(extras.reviewRequests === undefined ? {} : { reviewRequests: extras.reviewRequests }),
});

/**
 * Returns the reviews a pull request asks of the user and their teams now,
 * as the snapshot keeps them: `you`, and `team:<org>/<slug>` per team,
 * sorted.
 */
const readReviewRequests = (poll: ActivityPoll, pull: ListedPull): Array<string> => {
  const owner = poll.repo.split("/")[0]!;
  const you = (pull.requested_reviewers ?? []).some((account) =>
    isUserAccount(poll.identity, account),
  );
  const teams = (pull.requested_teams ?? [])
    .map((team) => buildTeamName(owner, team.slug))
    .filter((team) => poll.teams.has(team))
    .map((team) => `team:${team}`);
  return [...(you ? ["you"] : []), ...teams].sort();
};

/** Checks whether two sorted lists of review requests differ. */
const haveReviewRequestsChanged = (
  before: ReadonlyArray<string>,
  after: ReadonlyArray<string>,
): boolean => before.join("\n") !== after.join("\n");

/**
 * Fetches a pull request's reviews and emits one `github.pr.review-submitted`
 * per review submitted at or after `start`. A pending review is not submitted
 * yet, and a dismissed one is no longer a verdict, so neither emits.
 */
export const emitNewReviews = (
  poll: ActivityPoll,
  item: GithubItem,
  start: string | undefined,
): Effect.Effect<void, FeedError, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const listing = yield* fetchListing(
      {
        method: "GET",
        path: `/repos/${poll.repo}/pulls/${String(item.number)}/reviews`,
        token: poll.token,
        query: { per_page: "100" },
      },
      MAX_DETAIL_PAGES,
    );
    for (const raw of listing.items) {
      const review = yield* decodeGithubValue(ListedReview, raw, "a review");
      yield* emitReviewEvent(poll, item, review, raw, start);
    }
  });

/**
 * Fetches a pull request, and emits `github.pr.synchronized` when it is open
 * and its head commit differs from the one in the snapshot. Returns the pull
 * request, for its head commit, review requests and who merged it.
 */
const fetchPullAndEmitNewHead = (
  poll: ActivityPoll,
  item: GithubItem,
  previousSha: string | undefined,
): Effect.Effect<ListedPull, FeedError, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const response = yield* fetchFeedResponse({
      method: "GET",
      path: `/repos/${poll.repo}/pulls/${String(item.number)}`,
      token: poll.token,
    });
    const body = yield* readGithubObject(response.body, "a pull request");
    const pull = yield* decodeGithubValue(ListedPull, body, "a pull request");
    if (pull.state === "open" && previousSha !== undefined && previousSha !== pull.head.sha) {
      yield* poll.emit(
        buildItemEvent(item, {
          kind: "github.pr.synchronized",
          // Twelve characters of a commit SHA name it within one pull request,
          // and keep the key under the host's 200 characters.
          dedupKey: `pr.synchronized:${poll.repo}#${String(item.number)}:${pull.head.sha.slice(0, 12)}`,
          occurredAt: pull.updated_at,
          title: `New commits were pushed to ${buildItemPlace(item)}`,
          author: null,
          raw: truncateRaw(body),
        }),
      );
    }
    return pull;
  });

/** Where one comment listing starts, and from when a comment counts as new. */
interface CommentQuery {
  /** The `since` of the listing, or undefined to list every comment. */
  readonly since: string | undefined;
  /** The comment listing to resume, which overrides `since` and the per-item starts. */
  readonly pending: PendingComments | undefined;
  /**
   * The time from which a comment on an item is new, by item number, as
   * `computeNewActivityStart` returns it. An item not in the map uses `since`.
   */
  readonly starts: ReadonlyMap<number, string | undefined>;
}

/**
 * Fetches the repository's comments updated since `query.since`, and emits
 * `github.issue.commented` or `github.pr.commented` for each one created
 * at or after its item's start; an edited old comment emits nothing. These
 * are the comments on an issue or on a pull request's conversation. A
 * comment on a pull request's diff belongs to a review and arrives as
 * `github.pr.review-submitted`.
 *
 * Returns where the next poll resumes when the listing stopped at its page
 * limit, or undefined when every comment was read. A resumed listing counts
 * a comment as new when it was created at or after the cursor of the poll
 * that stopped, because that poll saved snapshots newer than the comments it
 * did not read.
 */
const emitNewComments = (
  poll: ActivityPoll,
  query: CommentQuery,
  listed: ReadonlyMap<number, GithubItem>,
): Effect.Effect<PendingComments | undefined, FeedError, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const since = query.pending?.since ?? query.since;
    const listing = yield* fetchListing(
      {
        method: "GET",
        path: `/repos/${poll.repo}/issues/comments`,
        token: poll.token,
        query: {
          sort: "updated",
          direction: "asc",
          per_page: "100",
          ...(since === undefined ? {} : { since }),
        },
      },
      MAX_DETAIL_PAGES,
    );
    const comments = yield* decodeGithubValue(
      Schema.Array(ListedComment),
      listing.items,
      "comments",
    );
    for (const [index, comment] of comments.entries()) {
      const number = Number(/\/issues\/(\d+)$/.exec(comment.issue_url)?.[1]);
      if (!Number.isInteger(number)) continue;
      const start =
        query.pending !== undefined
          ? query.pending.createdAfter
          : query.starts.has(number)
            ? query.starts.get(number)
            : query.since;
      if (!isAtOrAfter(comment.created_at, start)) continue;
      const kind = /\/pull\/\d+#/.test(comment.html_url) ? "pr" : "issue";
      const item = listed.get(number) ?? { repo: poll.repo, kind, number };
      yield* emitCommentEvents(poll, item, comment, listing.items[index]!);
    }
    const last = comments.at(-1);
    if (!listing.truncated || last === undefined) return undefined;
    const createdAfter = query.pending === undefined ? query.since : query.pending.createdAfter;
    return { since: last.updated_at, ...(createdAfter === undefined ? {} : { createdAfter }) };
  });

/**
 * Returns how many items at the start of a listing one poll diffs, given
 * the `updated_at` of each item, oldest first. The count reaches `limit`
 * and then stops at the end of a second, so items that share an
 * `updated_at` are diffed by the same poll.
 *
 * The count never stops before it has passed the second of `cursor`, the
 * last poll's cursor, and finished one second after it. The listing starts
 * with the cursor's second again, so a poll that stopped at the end of that
 * second would leave the cursor where it was, and a second holding more
 * items than the limit would be listed again forever.
 */
const countItemsToDiff = (
  updateTimes: ReadonlyArray<string>,
  cursor: string | undefined,
  limit: number,
): number => {
  // A poll can stop only between two items, so the earliest stop is after the first item.
  for (let index = Math.max(limit, 1); index < updateTimes.length; index += 1) {
    const last = updateTimes[index - 1]!;
    const endsSecond = Date.parse(updateTimes[index]!) !== Date.parse(last);
    if (endsSecond && isAfter(last, cursor)) return index;
  }
  return updateTimes.length;
};

/**
 * Polls one watched repository: lists what changed since the last poll,
 * diffs up to `MAX_ITEMS_PER_REPO` items of it as `countItemsToDiff` counts
 * them, emits an event for each change, and returns the new state. When
 * GitHub answers 304, only a comment listing left unfinished by the last
 * poll is read.
 */
const pollRepo = (
  poll: ActivityPoll,
  stored: RepoState,
): Effect.Effect<RepoState, FeedError, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const listing = yield* fetchListing(
      {
        method: "GET",
        path: `/repos/${poll.repo}/issues`,
        token: poll.token,
        query: {
          state: "all",
          sort: "updated",
          direction: "asc",
          per_page: "100",
          ...(stored.cursor === undefined ? {} : { since: stored.cursor }),
        },
        ...(stored.etag === undefined ? {} : { etag: stored.etag }),
      },
      MAX_LISTING_PAGES,
    );

    const issues = yield* Effect.forEach(listing.items, (raw) =>
      Effect.map(decodeGithubValue(ListedIssue, raw, "an issue"), (issue) => ({ issue, raw })),
    );
    const listed = new Map(
      issues.map(({ issue }) => [issue.number, buildIssueItem(poll.repo, issue)] as const),
    );
    const updateTimes = issues.map(({ issue }) => issue.updated_at);
    const diffed = issues.slice(
      0,
      countItemsToDiff(updateTimes, stored.cursor, MAX_ITEMS_PER_REPO),
    );
    const items: Record<string, ItemSnapshot> = { ...stored.items };
    const commentStarts = new Map<number, string | undefined>();

    for (const { issue, raw } of diffed) {
      const previous = stored.items[String(issue.number)];
      const item = buildIssueItem(poll.repo, issue);
      const start = computeNewActivityStart(issue, previous, stored.cursor);
      // A pull request that is open, or was open at the last poll, is read
      // whole: for its head commit and review requests, or for who merged it.
      const pull =
        item.kind === "pr" && (issue.state === "open" || previous?.state === "open")
          ? yield* fetchPullAndEmitNewHead(poll, item, previous?.headSha)
          : undefined;
      const mergedBy = pull?.merged_by?.login ?? null;
      for (const change of listItemChanges(poll.repo, issue, previous, stored.cursor, mergedBy)) {
        yield* poll.emit(buildItemEvent(item, { ...change, raw: truncateRaw(raw) }));
      }
      let headSha = previous?.headSha;
      let reviewRequests = previous?.reviewRequests;
      if (item.kind === "pr") {
        if (pull !== undefined && pull.state === "open") {
          headSha = pull.head.sha;
          const now = readReviewRequests(poll, pull);
          // A pull request new since the last poll has every request in its
          // history after `start`; one the snapshot has without requests
          // was written by an older version, and counts as unchanged.
          const before = previous === undefined ? [] : previous.reviewRequests;
          if (before !== undefined && haveReviewRequestsChanged(before, now)) {
            yield* emitReviewRequestEvents(poll, item, start);
          }
          reviewRequests = now;
        }
        yield* emitNewReviews(poll, item, start);
      }
      // Every diffed item arms the comment listing, not only one whose comment
      // count went up: a comment deleted and another added leave the count
      // as it was. The listing covers the whole repository, so this costs one
      // request per poll, not one per item.
      commentStarts.set(issue.number, start);
      // The newest items are listed again by every poll, because `since`
      // includes the cursor's second. The baseline mark stays until the
      // item's update time moves, or the second listing would count the
      // baseline's comments and reviews as new.
      const unchangedSinceBaseline =
        previous?.fromBaseline === true && previous.updatedAt === issue.updated_at;
      items[String(issue.number)] = buildItemSnapshot(issue, {
        headSha,
        reviewRequests: item.kind === "pr" ? reviewRequests : undefined,
        fromBaseline: unchangedSinceBaseline,
      });
    }
    const pendingComments =
      commentStarts.size > 0 || stored.pendingComments !== undefined
        ? yield* emitNewComments(
            poll,
            { since: stored.cursor, pending: stored.pendingComments, starts: commentStarts },
            listed,
          )
        : undefined;

    const cursor = diffed.reduce<string | undefined>(
      (latest, { issue }) => (isAtOrAfter(issue.updated_at, latest) ? issue.updated_at : latest),
      stored.cursor,
    );
    // GitHub answers 304 when the listing is the same as when it sent the
    // ETag. A poll that left listed items undiffed keeps no ETag, or the
    // next poll's 304 would skip them.
    const stoppedEarly = diffed.length < issues.length || listing.truncated;
    const etag = listing.unchanged
      ? stored.etag
      : stoppedEarly
        ? undefined
        : listing.firstPage.etag;
    return {
      ...(cursor === undefined ? {} : { cursor }),
      ...(etag === undefined ? {} : { etag }),
      items: evictClosedItems(items, cursor),
      ...(pendingComments === undefined ? {} : { pendingComments }),
    };
  });

/**
 * Returns the snapshot without the closed items last updated more than seven
 * days before the cursor. Measured from the cursor, GitHub's own clock,
 * rather than from this machine's.
 */
const evictClosedItems = (
  items: Readonly<Record<string, ItemSnapshot>>,
  cursor: string | undefined,
): Record<string, ItemSnapshot> => {
  if (cursor === undefined) return { ...items };
  const oldest = Date.parse(cursor) - CLOSED_RETENTION_MS;
  return Object.fromEntries(
    Object.entries(items).filter(
      ([, item]) => item.state === "open" || Date.parse(item.updatedAt) >= oldest,
    ),
  );
};

/**
 * Polls the repos feed once:
 *
 * 1. the repositories on the watch list in turn, until the poll has sent
 *    `MAX_REQUESTS_PER_POLL` requests. A repository with no state yet
 *    baselines and emits nothing;
 * 2. then the followed items outside the watch list (`followed.ts`): the
 *    user's own open pull requests, the items with an open signal, and the
 *    items the notifications feed saw news on.
 *
 * Fails as `pollWatchedRepos` fails, and as `pollFollowedItems` fails.
 */
export const pollRepos = (
  token: string,
  context: Pick<IngestContext, "emit" | "state" | "openSignals">,
  watchList: ReadonlyArray<string>,
  identity: GithubIdentity,
): Effect.Effect<PollResult, FeedError, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const teams = yield* readUserTeams(token, context.state);
    // Every request of the poll goes through this client, next pages
    // included, so the count is what GitHub received.
    let requests = 0;
    const client = HttpClient.tapRequest(yield* HttpClient.HttpClient, () =>
      Effect.sync(() => {
        requests += 1;
      }),
    );
    yield* pollWatchedRepos(
      "repos",
      context.state,
      watchList,
      RepoState,
      (repo, stored) => {
        const poll: ActivityPoll = { repo, token, emit: context.emit, identity, teams };
        return Option.isNone(stored) ? baselineRepo(poll) : pollRepo(poll, stored.value);
      },
      { isSpent: () => requests >= MAX_REQUESTS_PER_POLL },
    ).pipe(Effect.provideService(HttpClient.HttpClient, client));
    yield* pollFollowedItems(token, context, watchList, identity, teams);
    return {};
  });
