/**
 * The `repos` feed: the life of every issue and pull request in the watched
 * repositories, found by diffing what GitHub lists now against a snapshot of
 * what it listed before.
 *
 * Per repository and poll, the requests are:
 *
 * 1. `GET /repos/{o}/{r}/issues?state=all&sort=updated&direction=asc&since=<cursor>`,
 *    with the last ETag. It lists issues and pull requests updated since the
 *    last poll. `since` includes the cursor's own second, so the listing
 *    repeats the items updated in that second, and every item listed is
 *    diffed again. GitHub's `updated_at` counts whole seconds, so an item
 *    can change twice in one second without its `updated_at` moving; a diff
 *    that finds nothing new emits nothing. A repository where nothing
 *    changed answers 304, which costs no quota.
 * 2. For each pull request in that list: `GET .../pulls/{n}/reviews`, for new
 *    reviews, and, when it is open, `GET .../pulls/{n}`, for its head commit.
 * 3. When an item's comment count went up, or the last poll's comment
 *    listing stopped at its page limit: one
 *    `GET /repos/{o}/{r}/issues/comments?since=<cursor>` for the whole
 *    repository.
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
 * is its id, so seeing it again in the next poll writes nothing. The price:
 * a comment or review that was already there at the snapshot, in that same
 * second, is emitted once, even when the snapshot is the baseline.
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
import type * as HttpClient from "effect/unstable/http/HttpClient";
import type { IngestContext, PollResult } from "@hercule/plugin-host";
import { readReviewVerdict } from "../github-objects";
import { buildItemEvent, type GithubItem } from "../subject";
import { computeDigest } from "./digest";
import { ListedComment, ListedIssue, ListedPull, ListedReview } from "./feed-objects";
import {
  decodeGithubValue,
  fetchFeedResponse,
  fetchListing,
  readGithubObject,
  truncateRaw,
  type FeedError,
} from "./requests";
import { pollWatchedRepos, type RepoPoll } from "./state";

/** What the snapshot keeps of one issue or pull request: only what a diff compares. */
const ItemSnapshot = Schema.Struct({
  pullRequest: Schema.Boolean,
  state: Schema.String,
  labels: Schema.Array(Schema.String),
  assignees: Schema.Array(Schema.String),
  comments: Schema.Int,
  updatedAt: Schema.String,
  /** The head commit of an open pull request, to tell when a new one was pushed. */
  headSha: Schema.optionalKey(Schema.String),
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
  readonly fields?: Readonly<Record<string, unknown>>;
}

/** Returns the values that are not in `reference`, sorted. */
const listMissingFrom = (
  values: ReadonlyArray<string>,
  reference: ReadonlyArray<string>,
): Array<string> => values.filter((value) => !reference.includes(value)).sort();

/** Checks whether ISO 8601 timestamp `time` is at or after `start`. An absent start is before everything. */
const isAtOrAfter = (time: string, start: string | undefined): boolean =>
  start === undefined || Date.parse(time) >= Date.parse(start);

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
 * Returns the time from which a comment or review on an item is new: the
 * item's snapshot, or the cursor for an old item with no snapshot. Returns
 * undefined for a new item, whose every comment and review is new.
 */
const computeNewActivityStart = (
  issue: ListedIssue,
  previous: ItemSnapshot | undefined,
  cursor: string | undefined,
): string | undefined =>
  previous?.updatedAt ?? (isNewItem(issue, previous, cursor) ? undefined : cursor);

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
 */
const listItemChanges = (
  repo: string,
  issue: ListedIssue,
  previous: ItemSnapshot | undefined,
  cursor: string | undefined,
): ReadonlyArray<ItemChange> => {
  const kind = issue.pull_request === undefined ? "issue" : "pr";
  const item = `${repo}#${String(issue.number)}`;
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
    });
  }
  if (kind === "issue" && before.state === "closed" && issue.state === "open") {
    changes.push({
      kind: "github.issue.reopened",
      dedupKey: `issue.reopened:${diffed}`,
      occurredAt: issue.updated_at,
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
      fields: { added, removed },
    });
  }
  const assigned = listMissingFrom(readAssignees(issue), before.assignees);
  if (kind === "issue" && assigned.length > 0) {
    changes.push({
      kind: "github.issue.assigned",
      dedupKey: `issue.assigned:${diffed}:${computeDigest(assigned)}`,
      occurredAt: issue.updated_at,
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
          }
        : { kind: "github.pr.merged", dedupKey: `pr.merged:${item}`, occurredAt: mergedAt },
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
const baselineRepo = (poll: RepoPoll): Effect.Effect<RepoState, FeedError, HttpClient.HttpClient> =>
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
    const headSha = new Map(heads.map((pull) => [pull.number, pull.head.sha]));
    const items: Record<string, ItemSnapshot> = {};
    for (const issue of [...issues, latest])
      items[String(issue.number)] = buildItemSnapshot(issue, headSha.get(issue.number));
    return { cursor: latest.updated_at, items };
  });

/** Builds an item's snapshot from the listing, with its head commit when it has one. */
const buildItemSnapshot = (issue: ListedIssue, headSha: string | undefined): ItemSnapshot => ({
  pullRequest: issue.pull_request !== undefined,
  state: issue.state,
  labels: readLabels(issue),
  assignees: readAssignees(issue),
  comments: issue.comments,
  updatedAt: issue.updated_at,
  ...(headSha === undefined ? {} : { headSha }),
});

/**
 * Fetches a pull request's reviews and emits one `github.pr.review-submitted`
 * per review submitted at or after `start`. A pending review is not submitted
 * yet, and a dismissed one is no longer a verdict, so neither emits.
 */
const emitNewReviews = (
  poll: RepoPoll,
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
      const verdict = readReviewVerdict(review.state);
      const submittedAt = review.submitted_at ?? null;
      if (verdict === undefined || submittedAt === null || !isAtOrAfter(submittedAt, start)) {
        continue;
      }
      yield* poll.emit(
        buildItemEvent(item, {
          kind: "github.pr.review-submitted",
          dedupKey: `pr.review-submitted:${String(review.id)}`,
          occurredAt: submittedAt,
          fields: { reviewer: review.user?.login ?? "ghost", verdict },
          raw: truncateRaw(raw),
        }),
      );
    }
  });

/**
 * Fetches an open pull request's head commit, and emits
 * `github.pr.synchronized` when it differs from the one in the snapshot.
 * Returns the head commit, for the new snapshot.
 */
const emitNewHead = (
  poll: RepoPoll,
  item: GithubItem,
  previousSha: string | undefined,
): Effect.Effect<string, FeedError, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const response = yield* fetchFeedResponse({
      method: "GET",
      path: `/repos/${poll.repo}/pulls/${String(item.number)}`,
      token: poll.token,
    });
    const body = yield* readGithubObject(response.body, "a pull request");
    const pull = yield* decodeGithubValue(ListedPull, body, "a pull request");
    if (previousSha !== undefined && previousSha !== pull.head.sha) {
      yield* poll.emit(
        buildItemEvent(item, {
          kind: "github.pr.synchronized",
          // Twelve characters of a commit SHA name it within one pull request,
          // and keep the key under the host's 200 characters.
          dedupKey: `pr.synchronized:${poll.repo}#${String(item.number)}:${pull.head.sha.slice(0, 12)}`,
          occurredAt: pull.updated_at,
          raw: truncateRaw(body),
        }),
      );
    }
    return pull.head.sha;
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
  poll: RepoPoll,
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
      yield* poll.emit(
        buildItemEvent(item, {
          kind: `github.${kind}.commented`,
          dedupKey: `${kind}.commented:${String(comment.id)}`,
          occurredAt: comment.created_at,
          raw: truncateRaw(listing.items[index]!),
        }),
      );
    }
    const last = comments.at(-1);
    if (!listing.truncated || last === undefined) return undefined;
    const createdAfter = query.pending === undefined ? query.since : query.pending.createdAfter;
    return { since: last.updated_at, ...(createdAfter === undefined ? {} : { createdAfter }) };
  });

/**
 * Polls one watched repository: lists what changed since the last poll,
 * emits an event for each change, and returns the new state. When GitHub
 * answers 304, only a comment listing left unfinished by the last poll is
 * read.
 */
const pollRepo = (
  poll: RepoPoll,
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
    const items: Record<string, ItemSnapshot> = { ...stored.items };
    const commentStarts = new Map<number, string | undefined>();

    for (const { issue, raw } of issues) {
      const previous = stored.items[String(issue.number)];
      const item = buildIssueItem(poll.repo, issue);
      const start = computeNewActivityStart(issue, previous, stored.cursor);
      for (const change of listItemChanges(poll.repo, issue, previous, stored.cursor)) {
        yield* poll.emit(buildItemEvent(item, { ...change, raw: truncateRaw(raw) }));
      }
      let headSha = previous?.headSha;
      if (item.kind === "pr") {
        if (issue.state === "open") headSha = yield* emitNewHead(poll, item, previous?.headSha);
        yield* emitNewReviews(poll, item, start);
      }
      if (issue.comments > (previous?.comments ?? 0)) commentStarts.set(issue.number, start);
      items[String(issue.number)] = buildItemSnapshot(issue, headSha);
    }
    const pendingComments =
      commentStarts.size > 0 || stored.pendingComments !== undefined
        ? yield* emitNewComments(
            poll,
            { since: stored.cursor, pending: stored.pendingComments, starts: commentStarts },
            listed,
          )
        : undefined;

    const cursor = issues.reduce<string | undefined>(
      (latest, { issue }) => (isAtOrAfter(issue.updated_at, latest) ? issue.updated_at : latest),
      stored.cursor,
    );
    const etag = listing.unchanged ? stored.etag : listing.firstPage.etag;
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
 * Polls the repos feed once: every repository on the watch list, in turn.
 * A repository with no state yet baselines and emits nothing. Fails as
 * `pollWatchedRepos` fails.
 */
export const pollRepos = (
  token: string,
  context: Pick<IngestContext, "emit" | "state">,
  watchList: ReadonlyArray<string>,
): Effect.Effect<PollResult, FeedError, HttpClient.HttpClient> =>
  Effect.as(
    pollWatchedRepos("repos", context.state, watchList, RepoState, (repo, stored) => {
      const poll: RepoPoll = { repo, token, emit: context.emit };
      return Option.isNone(stored) ? baselineRepo(poll) : pollRepo(poll, stored.value);
    }),
    {},
  );
