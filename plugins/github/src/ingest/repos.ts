/**
 * The `repos` feed: the life of every issue and pull request in the watched
 * repositories, found by diffing what GitHub lists now against a snapshot of
 * what it listed before.
 *
 * Per repository and poll, the requests are:
 *
 * 1. `GET /repos/{o}/{r}/issues?state=all&sort=updated&direction=asc&since=<cursor>`,
 *    with the last ETag. It lists issues and pull requests updated since the
 *    last poll. A repository where nothing changed answers 304, which costs
 *    no quota, and the poll stops there.
 * 2. For each pull request in that list: `GET .../pulls/{n}/reviews`, for new
 *    reviews, and, when it is open, `GET .../pulls/{n}`, for its head commit.
 * 3. When an item's comment count went up: one
 *    `GET /repos/{o}/{r}/issues/comments?since=<cursor>` for the whole
 *    repository.
 *
 * The snapshot holds every open item and every item closed in the last seven
 * days, so its size follows the repository's open work, not its history.
 * Because every open item is in it, an item missing from the snapshot that
 * existed before the last poll was closed: when it shows up open, it was
 * reopened.
 *
 * Every dedup key is built from GitHub's own ids and timestamps, so a poll
 * that emitted its events but failed before saving the snapshot emits the
 * same keys again on the next poll, and the host writes each event once.
 */
import { Effect, Option, Schema } from "effect";
import type * as HttpClient from "effect/unstable/http/HttpClient";
import type { IngestContext, PollResult } from "@hercule/plugin-host";
import { buildItemEvent, type GithubItem } from "../subject";
import {
  GithubComment,
  GithubIssue,
  GithubPull,
  GithubReview,
  type GithubIssue as GithubIssueType,
} from "./github-objects";
import {
  decodeGithubValue,
  fetchGithub,
  fetchListing,
  truncateRaw,
  type FeedError,
} from "./requests";
import { pollWatchedRepos } from "./state";

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
});

type RepoState = Schema.Schema.Type<typeof RepoState>;

/**
 * The most pages of the issue listing one poll fetches, 100 items each. The
 * listing runs oldest first and the cursor stops at the last item read, so
 * whatever is beyond is read by the next poll.
 */
const MAX_LISTING_PAGES = 10;

/**
 * The most pages a first poll reads of a repository's open issues and open
 * pull requests, 100 each. An item beyond that is not in the snapshot, so its
 * first change is not diffed: it is recorded, and only later changes emit.
 */
const MAX_BASELINE_PAGES = 50;

/** The most pages of reviews or comments one poll reads for one item or repository. */
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

/** Returns the values in `after` that are not in `before`, sorted. */
const listAdded = (before: ReadonlyArray<string>, after: ReadonlyArray<string>): Array<string> =>
  after.filter((value) => !before.includes(value)).sort();

/** Checks whether ISO 8601 timestamp `time` is at or after `cursor`. An absent cursor is before everything. */
const isAtOrAfter = (time: string, cursor: string | undefined): boolean =>
  cursor === undefined || Date.parse(time) >= Date.parse(cursor);

/** Returns the label names of an issue. */
const readLabels = (issue: GithubIssueType): Array<string> =>
  issue.labels.map((label) => label.name);

/** Returns the logins of an issue's assignees. */
const readAssignees = (issue: GithubIssueType): Array<string> =>
  (issue.assignees ?? []).map((user) => user.login);

/** Describes an issue from the listing as the item the subject block is built from. */
const describeIssue = (repo: string, issue: GithubIssueType): GithubItem => ({
  repo,
  kind: issue.pull_request === undefined ? "issue" : "pr",
  number: issue.number,
  title: issue.title,
  ...(issue.user === null ? {} : { author: issue.user.login }),
  state: issue.state,
});

/**
 * Lists the events one issue or pull request produces, by comparing it with
 * its snapshot from the last poll. `cursor` is where the last poll's listing
 * ended.
 *
 * - Not in the snapshot and created since the cursor: it is new. It is
 *   `opened`, and compared with an empty open item, so labels, assignees and
 *   a close that came with it emit too.
 * - Not in the snapshot and older: it was closed at the last poll, because
 *   every open item is in the snapshot. When it is open now, an issue is
 *   `reopened`; nothing else is known about how it was before.
 * - In the snapshot: a close is `closed`, or `merged` for a pull request with
 *   a merge time; a reopen is `reopened` for an issue; labels added or
 *   removed are one `labeled`; new assignees are one `assigned`.
 *
 * GitHub has no reopened kind for a pull request in this roster, and no
 * unassigned kind, so those changes emit nothing.
 */
export const listItemChanges = (
  repo: string,
  issue: GithubIssueType,
  previous: ItemSnapshot | undefined,
  cursor: string | undefined,
): ReadonlyArray<ItemChange> => {
  const kind = issue.pull_request === undefined ? "issue" : "pr";
  const item = `${repo}#${String(issue.number)}`;
  const isNew = previous === undefined && isAtOrAfter(issue.created_at, cursor);
  const stateBefore = previous?.state ?? (isNew ? "open" : "closed");
  // An old item outside the snapshot has no known labels or assignees to compare.
  const known: Pick<ItemSnapshot, "labels" | "assignees"> | undefined =
    previous ?? (isNew ? { labels: [], assignees: [] } : undefined);
  const changes: Array<ItemChange> = [];

  if (isNew) {
    changes.push({
      kind: `github.${kind}.opened`,
      dedupKey: `${kind}.opened:${item}`,
      occurredAt: issue.created_at,
    });
  }
  if (kind === "issue" && stateBefore === "closed" && issue.state === "open") {
    changes.push({
      kind: "github.issue.reopened",
      dedupKey: `issue.reopened:${item}:${issue.updated_at}`,
      occurredAt: issue.updated_at,
    });
  }
  if (known !== undefined) {
    const labels = readLabels(issue);
    const added = listAdded(known.labels, labels);
    const removed = listAdded(labels, known.labels);
    if (added.length > 0 || removed.length > 0) {
      changes.push({
        kind: `github.${kind}.labeled`,
        dedupKey: `${kind}.labeled:${item}:+${added.join(",")}:-${removed.join(",")}:${issue.updated_at}`,
        occurredAt: issue.updated_at,
        fields: { added, removed },
      });
    }
    const assigned = listAdded(known.assignees, readAssignees(issue));
    if (assigned.length > 0) {
      changes.push({
        kind: `github.${kind}.assigned`,
        dedupKey: `${kind}.assigned:${item}:${assigned.join(",")}:${issue.updated_at}`,
        occurredAt: issue.updated_at,
      });
    }
  }
  if (stateBefore === "open" && issue.state === "closed") {
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
 * Returns the hyphenated verdict of a submitted review, or undefined for a
 * review that is still pending or was dismissed, which emit nothing.
 */
const readVerdict = (state: string): "approved" | "changes-requested" | "commented" | undefined => {
  switch (state) {
    case "APPROVED":
      return "approved";
    case "CHANGES_REQUESTED":
      return "changes-requested";
    case "COMMENTED":
      return "commented";
    default:
      return undefined;
  }
};

/** The per-repository work of one poll: what it needs and where its events go. */
interface RepoPoll {
  readonly repo: string;
  readonly token: string;
  readonly emit: IngestContext["emit"];
}

/**
 * Records where a newly watched repository stands and emits nothing: the
 * newest update as the cursor, and every open issue and pull request, with
 * the head commit of each pull request, as the snapshot.
 */
const baselineRepo = (poll: RepoPoll): Effect.Effect<RepoState, FeedError, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const path = `/repos/${poll.repo}`;
    const newest = yield* fetchGithub({
      method: "GET",
      path: `${path}/issues`,
      token: poll.token,
      query: { state: "all", sort: "updated", direction: "desc", per_page: "1" },
    });
    const [latest] = yield* decodeGithubValue(
      Schema.Array(GithubIssue),
      newest.body,
      "the newest issue",
    );
    const open = yield* fetchListing(
      {
        method: "GET",
        path: `${path}/issues`,
        token: poll.token,
        query: { state: "open", per_page: "100" },
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
    const issues = yield* decodeGithubValue(Schema.Array(GithubIssue), open.items, "open issues");
    const heads = yield* decodeGithubValue(
      Schema.Array(GithubPull),
      pulls.items,
      "open pull requests",
    );
    const headSha = new Map(heads.map((pull) => [pull.number, pull.head.sha]));
    const items: Record<string, ItemSnapshot> = {};
    for (const issue of issues)
      items[String(issue.number)] = recordIssue(issue, headSha.get(issue.number));
    return { ...(latest === undefined ? {} : { cursor: latest.updated_at }), items };
  });

/** Builds an item's snapshot from the listing, with its head commit when it has one. */
const recordIssue = (issue: GithubIssueType, headSha: string | undefined): ItemSnapshot => ({
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
 * per review submitted since the cursor. A pending review is not submitted
 * yet, and a dismissed one is no longer a verdict, so neither emits.
 */
const emitNewReviews = (
  poll: RepoPoll,
  item: GithubItem,
  cursor: string | undefined,
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
      const review = yield* decodeGithubValue(GithubReview, raw, "a review");
      const verdict = readVerdict(review.state);
      const submittedAt = review.submitted_at ?? null;
      if (verdict === undefined || submittedAt === null || !isAtOrAfter(submittedAt, cursor)) {
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
    const response = yield* fetchGithub({
      method: "GET",
      path: `/repos/${poll.repo}/pulls/${String(item.number)}`,
      token: poll.token,
    });
    const pull = yield* decodeGithubValue(GithubPull, response.body, "a pull request");
    if (previousSha !== undefined && previousSha !== pull.head.sha) {
      yield* poll.emit(
        buildItemEvent(item, {
          kind: "github.pr.synchronized",
          dedupKey: `pr.synchronized:${poll.repo}#${String(item.number)}:${pull.head.sha}`,
          occurredAt: pull.updated_at,
          raw: truncateRaw(response.body),
        }),
      );
    }
    return pull.head.sha;
  });

/**
 * Fetches the repository's comments updated since the cursor, and emits
 * `github.issue.commented` or `github.pr.commented` for each one created
 * since the cursor; an edited old comment emits nothing. These are the
 * comments on an issue or on a pull request's conversation. A comment on a
 * pull request's diff belongs to a review and arrives as
 * `github.pr.review-submitted`.
 */
const emitNewComments = (
  poll: RepoPoll,
  cursor: string | undefined,
  listed: ReadonlyMap<number, GithubItem>,
): Effect.Effect<void, FeedError, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const listing = yield* fetchListing(
      {
        method: "GET",
        path: `/repos/${poll.repo}/issues/comments`,
        token: poll.token,
        query: {
          sort: "updated",
          direction: "asc",
          per_page: "100",
          ...(cursor === undefined ? {} : { since: cursor }),
        },
      },
      MAX_DETAIL_PAGES,
    );
    for (const raw of listing.items) {
      const comment = yield* decodeGithubValue(GithubComment, raw, "a comment");
      const number = Number(/\/issues\/(\d+)$/.exec(comment.issue_url)?.[1]);
      if (!Number.isInteger(number) || !isAtOrAfter(comment.created_at, cursor)) continue;
      const kind = comment.html_url.includes("/pull/") ? "pr" : "issue";
      const item = listed.get(number) ?? { repo: poll.repo, kind, number };
      yield* poll.emit(
        buildItemEvent(item, {
          kind: `github.${kind}.commented`,
          dedupKey: `${kind}.commented:${String(comment.id)}`,
          occurredAt: comment.created_at,
          raw: truncateRaw(raw),
        }),
      );
    }
  });

/**
 * Polls one watched repository: lists what changed since the last poll,
 * emits an event for each change, and returns the new state. Returns the
 * stored state as it was when GitHub answers 304.
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
    if (listing.unchanged) return stored;

    const issues = yield* Effect.forEach(listing.items, (raw) =>
      Effect.map(decodeGithubValue(GithubIssue, raw, "an issue"), (issue) => ({ issue, raw })),
    );
    // The listing repeats the item at the cursor, because `since` includes it.
    const changed = issues.filter(
      ({ issue }) => stored.items[String(issue.number)]?.updatedAt !== issue.updated_at,
    );
    const listed = new Map(
      issues.map(({ issue }) => [issue.number, describeIssue(poll.repo, issue)] as const),
    );
    const items: Record<string, ItemSnapshot> = { ...stored.items };
    let needsComments = false;

    for (const { issue, raw } of changed) {
      const previous = stored.items[String(issue.number)];
      const item = describeIssue(poll.repo, issue);
      for (const change of listItemChanges(poll.repo, issue, previous, stored.cursor)) {
        yield* poll.emit(buildItemEvent(item, { ...change, raw: truncateRaw(raw) }));
      }
      let headSha = previous?.headSha;
      if (item.kind === "pr") {
        if (issue.state === "open") headSha = yield* emitNewHead(poll, item, previous?.headSha);
        yield* emitNewReviews(poll, item, stored.cursor);
      }
      if (issue.comments > (previous?.comments ?? 0)) needsComments = true;
      items[String(issue.number)] = recordIssue(issue, headSha);
    }
    if (needsComments) yield* emitNewComments(poll, stored.cursor, listed);

    const cursor = issues.reduce<string | undefined>(
      (latest, { issue }) => (isAtOrAfter(issue.updated_at, latest) ? issue.updated_at : latest),
      stored.cursor,
    );
    return {
      ...(cursor === undefined ? {} : { cursor }),
      ...(listing.first.etag === undefined ? {} : { etag: listing.first.etag }),
      items: evictClosedItems(items, cursor),
    };
  });

/**
 * Returns the snapshot without the items closed for more than seven days
 * before the cursor. Measured from the cursor, GitHub's own clock, rather
 * than from this machine's.
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
