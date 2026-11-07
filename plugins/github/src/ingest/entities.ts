/**
 * The `entities` feed: reads the pull requests and issues that concern the
 * user, and the repositories they belong to, and reports them to the host as
 * External Entity observations.
 *
 * A poll has two parts:
 *
 * 1. The inventory. One GraphQL search per concern (`searchAllPages`), paged
 *    to the end. Only when every page of every search was read does the poll
 *    report anything, so a failed page, a rate limit or a restart reports
 *    nothing and takes nothing away.
 * 2. The refresh. The host names the pull requests, issues and repositories
 *    it wants read although they are not in the inventory, such as a pull
 *    request that was merged since and so left the `is:open` searches. One
 *    GraphQL request reads them all (`readEntitiesByRef`).
 *
 * The plugin reports raw `fields` and a status key. The tables in
 * `../entity-kinds.ts` say how a card shows them.
 */
import { Effect, Schema } from "effect";
import type * as HttpClient from "effect/http/HttpClient";
import {
  MAX_ENTITY_OBSERVATIONS,
  MAX_EVENT_TITLE_LENGTH,
  PluginError,
  type EntityObservation,
  type IngestEntities,
  type PollResult,
} from "@hercule/plugin-host";
import { ISSUE_KIND, PULL_REQUEST_KIND, REPOSITORY_KIND } from "../entity-kinds";
import {
  buildItemRef,
  buildRepoRef,
  buildRepoSubject,
  parseItemRef,
  parseRepoRef,
} from "../subject";
import { cutText } from "../text";
import { decodeGithubValue, fetchGraphql, type FeedError } from "./requests";

/** How many refs of one kind the poll asks the host for, and reads, each time. */
const WANTED_REFS_PER_KIND = 50;

/** How many assignees of an issue one read lists. */
const ASSIGNEES_READ = 5;

/** The concerns this feed reports. The host sets the others. */
type EntityConcern = "opened" | "review-requested" | "assigned";

// ---------------------------------------------------------------------------
// What GitHub sends
// ---------------------------------------------------------------------------

/** The GraphQL fields of a repository, as a named fragment. The two item fragments spread it. */
const REPOSITORY_FRAGMENT = `fragment RepositoryFields on Repository { nameWithOwner createdAt }`;

const PULL_REQUEST_FRAGMENT = `fragment PullRequestFields on PullRequest {
  __typename number title url isDraft state updatedAt
  author { login }
  repository { ...RepositoryFields }
  headRefName
  headRepository { nameWithOwner }
  reviewDecision additions deletions changedFiles
  commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
}`;

const ISSUE_FRAGMENT = `fragment IssueFields on Issue {
  __typename number title url state stateReason updatedAt
  repository { ...RepositoryFields }
  assignees(first: ${String(ASSIGNEES_READ)}) { totalCount nodes { login } }
  labels(first: 5) { nodes { name } }
}`;

/**
 * Returns the fragment definitions a query needs, to be sent after the query.
 * The searches, the refresh and the lookup read the same fields through these
 * fragments. GraphQL refuses a document that defines a fragment nothing
 * spreads, so a query asks for exactly the item fragments it spreads
 * (`RepositoryFields` is always included: every selection reads it).
 */
export const buildFragments = (spreads: {
  readonly pullRequest: boolean;
  readonly issue: boolean;
}): string =>
  [
    REPOSITORY_FRAGMENT,
    ...(spreads.pullRequest ? [PULL_REQUEST_FRAGMENT] : []),
    ...(spreads.issue ? [ISSUE_FRAGMENT] : []),
  ].join("\n");

/** The fragments of a query that spreads both item fragments, as a search and a lookup do. */
export const ITEM_FRAGMENTS = buildFragments({ pullRequest: true, issue: true });

const RepositoryNode = Schema.Struct({
  nameWithOwner: Schema.String,
  createdAt: Schema.String,
});

type RepositoryNode = Schema.Schema.Type<typeof RepositoryNode>;

/** An account, or null for one GitHub deleted. */
const AccountNode = Schema.NullOr(Schema.Struct({ login: Schema.String }));

const PullRequestNode = Schema.Struct({
  __typename: Schema.Literal("PullRequest"),
  number: Schema.Int,
  title: Schema.String,
  url: Schema.String,
  isDraft: Schema.Boolean,
  /** `OPEN`, `CLOSED` or `MERGED`. */
  state: Schema.String,
  updatedAt: Schema.String,
  author: AccountNode,
  repository: RepositoryNode,
  headRefName: Schema.String,
  /** Null when the fork the branch lives in was deleted. */
  headRepository: Schema.NullOr(Schema.Struct({ nameWithOwner: Schema.String })),
  /** `APPROVED`, `CHANGES_REQUESTED`, `REVIEW_REQUIRED`, or null when no review is required. */
  reviewDecision: Schema.NullOr(Schema.String),
  additions: Schema.Int,
  deletions: Schema.Int,
  changedFiles: Schema.Int,
  commits: Schema.Struct({
    nodes: Schema.NullOr(
      Schema.Array(
        Schema.NullOr(
          Schema.Struct({
            commit: Schema.Struct({
              /** Null when the latest commit has no checks. Its `state` is `SUCCESS`, `FAILURE`, `PENDING`, ... */
              statusCheckRollup: Schema.NullOr(Schema.Struct({ state: Schema.String })),
            }),
          }),
        ),
      ),
    ),
  }),
});

type PullRequestNode = Schema.Schema.Type<typeof PullRequestNode>;

const IssueNode = Schema.Struct({
  __typename: Schema.Literal("Issue"),
  number: Schema.Int,
  title: Schema.String,
  url: Schema.String,
  /** `OPEN` or `CLOSED`. */
  state: Schema.String,
  /** Why a closed issue closed: `COMPLETED`, `NOT_PLANNED` or `DUPLICATE`. Null on an old closed issue. */
  stateReason: Schema.NullOr(Schema.String),
  updatedAt: Schema.String,
  repository: RepositoryNode,
  assignees: Schema.Struct({
    /** How many assignees the issue has, of which the read lists the first few. */
    totalCount: Schema.Int,
    nodes: Schema.NullOr(Schema.Array(AccountNode)),
  }),
  labels: Schema.Struct({
    nodes: Schema.NullOr(Schema.Array(Schema.NullOr(Schema.Struct({ name: Schema.String })))),
  }),
});

type IssueNode = Schema.Schema.Type<typeof IssueNode>;

/** A pull request or an issue, as a search or `issueOrPullRequest` returns it. */
export const ItemNode = Schema.Union([PullRequestNode, IssueNode]);

export type ItemNode = Schema.Schema.Type<typeof ItemNode>;

/** The account the token belongs to: what `@me` means in a search. */
export const ViewerNode = Schema.Struct({ login: Schema.String });

// ---------------------------------------------------------------------------
// From GitHub's words to observations
// ---------------------------------------------------------------------------

/** Checks whether `login` is the viewer's, ignoring case, as GitHub does. */
const isViewer = (login: string | undefined, viewerLogin: string): boolean =>
  login !== undefined && login.toLowerCase() === viewerLogin.toLowerCase();

/**
 * Returns the key of the pull request's status in the kind table: the state
 * that needs the most attention wins, so failed checks hide an approval.
 */
const decidePullRequestStatus = (node: PullRequestNode): string => {
  if (node.state === "MERGED") return "merged";
  if (node.state === "CLOSED") return "closed";
  if (node.isDraft) return "draft";
  const checks = node.commits.nodes?.[0]?.commit.statusCheckRollup?.state;
  if (checks === "FAILURE" || checks === "ERROR") return "failing";
  if (node.reviewDecision === "CHANGES_REQUESTED") return "changes";
  if (node.reviewDecision === "APPROVED") return "approved";
  return "open";
};

/** The reason a card of the user's own pull request gives, by status. A status left out has none. */
const OWN_PULL_REQUEST_REASONS: Readonly<Record<string, string>> = {
  failing: "checks-failed",
  changes: "changes-requested",
  approved: "approved",
  open: "waiting",
  merged: "merged",
};

const PULL_REQUEST_LIFECYCLES: Readonly<Record<string, "open" | "completed" | "abandoned">> = {
  MERGED: "completed",
  CLOSED: "abandoned",
};

/**
 * Returns what a closed issue's `stateReason` means for its lifecycle.
 * `NOT_PLANNED` and `DUPLICATE` are abandoned. `COMPLETED`, and no reason at
 * all, are completed: an issue closed before GitHub kept a reason was closed
 * because it was done.
 */
const decideIssueLifecycle = (node: IssueNode): "open" | "completed" | "abandoned" => {
  if (node.state === "OPEN") return "open";
  return node.stateReason === "NOT_PLANNED" || node.stateReason === "DUPLICATE"
    ? "abandoned"
    : "completed";
};

/** Returns the address of a repository the way a plugin reports it: `github.com/owner/repo`, lowercase. */
const buildRemote = (nameWithOwner: string): string => `github.com/${nameWithOwner.toLowerCase()}`;

/** Returns the relations of an item: GitHub always knows its repository, and reports nothing else. */
const buildRelations = (repo: string) => ({
  complete: true,
  partOf: [buildRepoRef(repo)],
  linked: [],
});

/**
 * Builds the observation of a pull request. `viewerLogin` is the token's
 * account, which decides `ownedByYou`; `concerns` says why the pull request
 * concerns the user, and is empty for one read only to refresh it.
 */
export const buildPullRequestObservation = (
  node: PullRequestNode,
  viewerLogin: string,
  concerns: ReadonlyArray<EntityConcern>,
): EntityObservation => {
  const repo = node.repository.nameWithOwner.toLowerCase();
  const status = decidePullRequestStatus(node);
  const ownedByYou = isViewer(node.author?.login, viewerLogin);
  const reason = ownedByYou ? OWN_PULL_REQUEST_REASONS[status] : undefined;
  return {
    kind: PULL_REQUEST_KIND,
    ref: buildItemRef({ repo, kind: "pr", number: node.number }),
    title: cutText(node.title, MAX_EVENT_TITLE_LENGTH),
    url: node.url,
    lifecycle: PULL_REQUEST_LIFECYCLES[node.state] ?? "open",
    status,
    repository: {
      target: { remote: buildRemote(repo) },
      ...(node.headRepository === null
        ? {}
        : {
            head: {
              remote: buildRemote(node.headRepository.nameWithOwner),
              branch: node.headRefName,
            },
          }),
    },
    relations: buildRelations(repo),
    fields: {
      number: node.number,
      repo,
      author: node.author?.login ?? null,
      // The kind's `delta` fact reads this text: additions, then deletions.
      diff: `+${String(node.additions)} -${String(node.deletions)}`,
      files: node.changedFiles,
    },
    concerns,
    ownedByYou,
    ...(reason === undefined ? {} : { reason }),
    sourceUpdatedAt: node.updatedAt,
  };
};

/**
 * The longest `labels` fact. The core shows the field as a word fact, which
 * the public API bounds at 80 characters, and refuses a whole inventory when
 * one card breaks a bound.
 */
export const MAX_LABELS_FACT_LENGTH = 80;

/**
 * Returns the label names as one line for the `labels` fact: as many whole
 * names as fit, comma separated, and when some are left out, a closing count
 * such as "bug, checkout +2". Returns null for no labels. The line is never
 * longer than `MAX_LABELS_FACT_LENGTH`.
 */
export const summarizeLabels = (names: ReadonlyArray<string>): string | null => {
  if (names.length === 0) return null;
  const all = names.join(", ");
  if (all.length <= MAX_LABELS_FACT_LENGTH) return all;
  for (let shown = names.length - 1; shown >= 1; shown--) {
    const line = `${names.slice(0, shown).join(", ")} +${String(names.length - shown)}`;
    if (line.length <= MAX_LABELS_FACT_LENGTH) return line;
  }
  // Not even the first name fits with a count: GitHub keeps label names to 50 characters, so this is only a guard.
  return cutText(all, MAX_LABELS_FACT_LENGTH);
};

/**
 * Decides whether the user is among an issue's assignees. Returns undefined
 * when that cannot be told:
 *
 * - The `assigned` concern comes from the search `assignee:@me`, which proves
 *   the user is assigned however many assignees there are.
 * - Otherwise the read lists only the first few assignees. The user in that
 *   list is assigned. The user missing from a complete list is not assigned.
 *   The user missing from a cut list may be the sixth, so nothing is claimed.
 */
const decideIssueOwnership = (
  node: IssueNode,
  assignees: ReadonlyArray<string>,
  viewerLogin: string,
  concerns: ReadonlyArray<EntityConcern>,
): boolean | undefined => {
  if (concerns.includes("assigned")) return true;
  if (assignees.some((login) => isViewer(login, viewerLogin))) return true;
  return node.assignees.totalCount > assignees.length ? undefined : false;
};

/** Builds the observation of an issue, as `buildPullRequestObservation` builds a pull request's. */
export const buildIssueObservation = (
  node: IssueNode,
  viewerLogin: string,
  concerns: ReadonlyArray<EntityConcern>,
): EntityObservation => {
  const repo = node.repository.nameWithOwner.toLowerCase();
  const lifecycle = decideIssueLifecycle(node);
  const assignees = (node.assignees.nodes ?? []).flatMap((account) =>
    account === null ? [] : [account.login],
  );
  const labels = (node.labels.nodes ?? []).flatMap((label) => (label === null ? [] : [label.name]));
  const ownedByYou = decideIssueOwnership(node, assignees, viewerLogin, concerns);
  return {
    kind: ISSUE_KIND,
    ref: buildItemRef({ repo, kind: "issue", number: node.number }),
    title: cutText(node.title, MAX_EVENT_TITLE_LENGTH),
    url: node.url,
    lifecycle,
    status: lifecycle === "open" ? "open" : "closed",
    repository: { target: { remote: buildRemote(repo) } },
    relations: buildRelations(repo),
    fields: {
      number: node.number,
      repo,
      assignee: assignees[0] ?? null,
      labels: summarizeLabels(labels),
    },
    concerns,
    ...(ownedByYou === undefined ? {} : { ownedByYou }),
    sourceUpdatedAt: node.updatedAt,
  };
};

/** Builds the observation of a pull request or an issue, as its kind does. */
export const buildItemObservation = (
  node: ItemNode,
  viewerLogin: string,
  concerns: ReadonlyArray<EntityConcern>,
): EntityObservation =>
  node.__typename === "PullRequest"
    ? buildPullRequestObservation(node, viewerLogin, concerns)
    : buildIssueObservation(node, viewerLogin, concerns);

/**
 * Builds the context observation of a repository: its name, no concerns and
 * no card. Its `sourceUpdatedAt` is the repository's creation time, because
 * a repository's name and address change only with a rename, which makes a
 * new ref, so no time is a better "last change" and a moving one would make
 * every push look like a change.
 */
const buildRepositoryObservation = (repository: RepositoryNode): EntityObservation => ({
  kind: REPOSITORY_KIND,
  ref: buildRepoRef(repository.nameWithOwner),
  title: repository.nameWithOwner,
  url: buildRepoSubject(repository.nameWithOwner).url,
  fields: { name: repository.nameWithOwner },
  concerns: [],
  sourceUpdatedAt: repository.createdAt,
});

// ---------------------------------------------------------------------------
// The inventory
// ---------------------------------------------------------------------------

/** One search per concern, by GitHub's search words. `@me` is the token's account. */
const CONCERN_SEARCHES: ReadonlyArray<{
  readonly qualifier: string;
  readonly concern: EntityConcern;
}> = [
  { qualifier: "is:pr is:open archived:false author:@me", concern: "opened" },
  { qualifier: "is:pr is:open archived:false review-requested:@me", concern: "review-requested" },
  { qualifier: "is:issue is:open archived:false assignee:@me", concern: "assigned" },
];

const SEARCH_QUERY = `
query ($query: String!, $after: String) {
  viewer { login }
  search(query: $query, type: ISSUE, first: 100, after: $after) {
    issueCount
    pageInfo { hasNextPage endCursor }
    nodes { ...PullRequestFields ...IssueFields }
  }
}
${ITEM_FRAGMENTS}`;

const SearchPage = Schema.Struct({
  viewer: ViewerNode,
  search: Schema.Struct({
    issueCount: Schema.Int,
    pageInfo: Schema.Struct({
      hasNextPage: Schema.Boolean,
      endCursor: Schema.NullOr(Schema.String),
    }),
    nodes: Schema.NullOr(Schema.Array(Schema.NullOr(ItemNode))),
  }),
});

type SearchPage = Schema.Schema.Type<typeof SearchPage>;

/** Reads one page of a search: the first when `after` is null, else the one after that cursor. */
const fetchSearchPage = (
  token: string,
  qualifier: string,
  after: string | null,
): Effect.Effect<SearchPage, FeedError, HttpClient.HttpClient> =>
  Effect.flatMap(fetchGraphql(token, SEARCH_QUERY, { query: qualifier, after }), (data) =>
    decodeGithubValue(SearchPage, data, "a page of search results"),
  );

/** Everything one search found. */
interface SearchResult {
  readonly viewerLogin: string;
  readonly items: ReadonlyArray<ItemNode>;
  /** False when GitHub counted more results than it let the search read: it stops at 1,000. */
  readonly complete: boolean;
}

/**
 * Runs one search and reads every page of it, one request per page of 100.
 * Fails as `fetchGraphql` fails, and with a `PluginError` when GitHub says
 * there is another page but gives no cursor for it.
 */
const searchAllPages = (
  token: string,
  qualifier: string,
): Effect.Effect<SearchResult, FeedError, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const pages: Array<SearchPage> = [];
    let after: string | null | undefined = null;
    while (after !== undefined) {
      const page: SearchPage = yield* fetchSearchPage(token, qualifier, after);
      pages.push(page);
      const { hasNextPage, endCursor } = page.search.pageInfo;
      if (hasNextPage && endCursor === null) {
        return yield* new PluginError({
          message: "GitHub has another page of search results but gave no cursor for it.",
        });
      }
      after = hasNextPage ? endCursor : undefined;
    }
    const nodes = pages.flatMap((page) => page.search.nodes ?? []);
    return {
      viewerLogin: pages[0]?.viewer.login ?? "",
      items: nodes.flatMap((node) => (node === null ? [] : [node])),
      complete: (pages.at(-1)?.search.issueCount ?? 0) <= nodes.length,
    };
  });

/**
 * Reads every search and reports the result to the host: the repositories
 * first, because the pull requests and issues are part of them, then the
 * pull requests, then the issues. Nothing is reported unless every page of
 * every search was read. A kind is `complete` only when each search that
 * feeds it was.
 */
const reconcileInventory = (
  token: string,
  entities: IngestEntities,
): Effect.Effect<void, FeedError, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    // A pull request found by two searches is one item with both concerns.
    const found = new Map<string, { node: ItemNode; concerns: Array<EntityConcern> }>();
    let viewerLogin = "";
    let pullRequestsComplete = true;
    let issuesComplete = true;
    for (const { qualifier, concern } of CONCERN_SEARCHES) {
      const result = yield* searchAllPages(token, qualifier);
      viewerLogin = result.viewerLogin;
      for (const node of result.items) {
        const key = `${node.__typename}:${node.repository.nameWithOwner.toLowerCase()}#${String(node.number)}`;
        const entry = found.get(key);
        if (entry === undefined) found.set(key, { node, concerns: [concern] });
        else entry.concerns.push(concern);
      }
      if (concern === "assigned") issuesComplete = result.complete;
      else pullRequestsComplete = pullRequestsComplete && result.complete;
    }

    const repositories = new Map<string, RepositoryNode>();
    const pullRequests: Array<EntityObservation> = [];
    const issues: Array<EntityObservation> = [];
    for (const { node, concerns } of found.values()) {
      repositories.set(node.repository.nameWithOwner.toLowerCase(), node.repository);
      (node.__typename === "PullRequest" ? pullRequests : issues).push(
        buildItemObservation(node, viewerLogin, concerns),
      );
    }

    // Each search reads at most 1,000 items, so the repositories of three
    // searches can pass the host's limit of one call. They go in batches.
    // Batches can be `complete` because a repository has no concerns: a
    // complete call empties the concerns of what it leaves out, and there are
    // none to empty, so a batch never clears what another batch lists.
    const repositoryObservations = [...repositories.values()].map(buildRepositoryObservation);
    const batchCount = Math.max(
      1,
      Math.ceil(repositoryObservations.length / MAX_ENTITY_OBSERVATIONS),
    );
    for (let batch = 0; batch < batchCount; batch++) {
      yield* entities.reconcile({
        kind: REPOSITORY_KIND,
        complete: true,
        observations: repositoryObservations.slice(
          batch * MAX_ENTITY_OBSERVATIONS,
          (batch + 1) * MAX_ENTITY_OBSERVATIONS,
        ),
      });
    }
    // Pull requests and issues are never batched. A complete call empties the
    // concerns of every earlier item it leaves out, so each kind must be
    // reported whole in one call. They fit: a search reads at most 1,000
    // items, so the two pull request searches give at most 2,000 (exactly the
    // host's limit) and the issue search at most 1,000.
    yield* entities.reconcile({
      kind: PULL_REQUEST_KIND,
      complete: pullRequestsComplete,
      observations: pullRequests,
    });
    yield* entities.reconcile({ kind: ISSUE_KIND, complete: issuesComplete, observations: issues });
  });

// ---------------------------------------------------------------------------
// The refresh
// ---------------------------------------------------------------------------

/** What one ref names, once parsed. */
type RefTarget =
  | { readonly kind: "pr" | "issue"; readonly repo: string; readonly number: number }
  | { readonly kind: "repo"; readonly repo: string };

/** Parses a ref this plugin built, or returns undefined for one it cannot read. */
const parseRefTarget = (ref: string): RefTarget | undefined => {
  const item = parseItemRef(ref);
  if (item !== undefined) return item;
  const repo = parseRepoRef(ref);
  return repo === undefined ? undefined : { kind: "repo", repo };
};

/**
 * Returns the GraphQL selection that reads `target` under the alias
 * `t<index>`. The owner, name and number are variables `$o<index>`,
 * `$n<index>` and `$i<index>`, never text pasted into the query.
 */
const buildSelection = (target: RefTarget, index: number): string => {
  const repository = `t${String(index)}: repository(owner: $o${String(index)}, name: $n${String(index)})`;
  switch (target.kind) {
    case "repo":
      return `${repository} { ...RepositoryFields }`;
    case "pr":
      return `${repository} { pullRequest(number: $i${String(index)}) { ...PullRequestFields } }`;
    case "issue":
      return `${repository} { issue(number: $i${String(index)}) { ...IssueFields } }`;
  }
};

/** Turns the answer to one alias into an observation, or undefined when GitHub answered `null`. */
const decodeRefAnswer = (
  target: RefTarget,
  value: unknown,
  viewerLogin: string,
): Effect.Effect<EntityObservation | undefined, PluginError> => {
  switch (target.kind) {
    case "repo":
      return Effect.map(
        decodeGithubValue(Schema.NullOr(RepositoryNode), value, "a repository"),
        (repository) => (repository === null ? undefined : buildRepositoryObservation(repository)),
      );
    case "pr":
      return Effect.map(
        decodeGithubValue(
          Schema.NullOr(Schema.Struct({ pullRequest: Schema.NullOr(PullRequestNode) })),
          value,
          "a pull request",
        ),
        (answer) =>
          answer?.pullRequest == null
            ? undefined
            : buildPullRequestObservation(answer.pullRequest, viewerLogin, []),
      );
    case "issue":
      return Effect.map(
        decodeGithubValue(
          Schema.NullOr(Schema.Struct({ issue: Schema.NullOr(IssueNode) })),
          value,
          "an issue",
        ),
        (answer) =>
          answer?.issue == null ? undefined : buildIssueObservation(answer.issue, viewerLogin, []),
      );
  }
};

/** What `readEntitiesByRef` found. */
interface RefReadResult {
  readonly observations: ReadonlyArray<EntityObservation>;
  /** The refs that came back empty, or that this plugin cannot read. */
  readonly missing: ReadonlyArray<string>;
}

/**
 * Reads the pull requests, issues and repositories that `refs` name, in one
 * GraphQL request with one alias per ref. A ref that names nothing this
 * plugin can read, or that GitHub answers with `null` (deleted, or not
 * visible to the token), is `missing`. Sends no request when no ref is
 * readable. Fails as `fetchGraphql` fails.
 */
export const readEntitiesByRef = (
  token: string,
  refs: ReadonlyArray<string>,
): Effect.Effect<RefReadResult, FeedError, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const targets: Array<{ readonly ref: string; readonly target: RefTarget }> = [];
    const missing: Array<string> = [];
    for (const ref of refs) {
      const target = parseRefTarget(ref);
      if (target === undefined) missing.push(ref);
      else targets.push({ ref, target });
    }
    if (targets.length === 0) return { observations: [], missing };

    const declarations: Array<string> = [];
    const variables: Record<string, string | number> = {};
    for (const [index, { target }] of targets.entries()) {
      const [owner = "", name = ""] = target.repo.split("/");
      declarations.push(`$o${String(index)}: String!`, `$n${String(index)}: String!`);
      variables[`o${String(index)}`] = owner;
      variables[`n${String(index)}`] = name;
      if (target.kind !== "repo") {
        declarations.push(`$i${String(index)}: Int!`);
        variables[`i${String(index)}`] = target.number;
      }
    }
    const selections = targets.map(({ target }, index) => buildSelection(target, index));
    const fragments = buildFragments({
      pullRequest: targets.some(({ target }) => target.kind === "pr"),
      issue: targets.some(({ target }) => target.kind === "issue"),
    });
    const query = `query (${declarations.join(", ")}) {
  viewer { login }
  ${selections.join("\n  ")}
}
${fragments}`;

    const data = yield* fetchGraphql(token, query, variables, { tolerateMissing: true });
    const answer = yield* decodeGithubValue(
      Schema.Record(Schema.String, Schema.Unknown),
      data,
      "the things asked for by ref",
    );
    const viewer = yield* decodeGithubValue(ViewerNode, answer["viewer"], "the viewer");
    const observations: Array<EntityObservation> = [];
    for (const [index, { ref, target }] of targets.entries()) {
      const observation = yield* decodeRefAnswer(target, answer[`t${String(index)}`], viewer.login);
      if (observation === undefined) missing.push(ref);
      else observations.push(observation);
    }
    return { observations, missing };
  });

/**
 * Asks the host which pull requests, issues and repositories it wants read
 * now, reads them, and hands over what was found. A ref GitHub cannot show is
 * reported `inaccessible`, never `deleted`, because GitHub answers the same
 * for a thing that is gone and for one the token lost access to.
 */
const refreshWantedEntities = (
  token: string,
  entities: IngestEntities,
): Effect.Effect<void, FeedError, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const refs: Array<string> = [];
    for (const kind of [PULL_REQUEST_KIND, ISSUE_KIND, REPOSITORY_KIND]) {
      refs.push(...(yield* entities.listWanted(kind, WANTED_REFS_PER_KIND)));
    }
    const { observations, missing } = yield* readEntitiesByRef(token, refs);
    if (observations.length > 0) yield* entities.refresh(observations);
    for (const ref of missing) yield* entities.reportMissing(ref, "inaccessible");
  });

/**
 * Polls the `entities` feed once: reports the inventory, then refreshes what
 * the host wants read. Costs one request per page of each of the three
 * searches, and one more for the refresh when anything is wanted. Fails as
 * `fetchGraphql` fails, and with the host's `PluginError` when it refuses
 * what was reported. The inventory is stored before the refresh starts, so
 * a refresh that fails leaves it in place.
 */
export const pollEntities = (
  token: string,
  entities: IngestEntities,
): Effect.Effect<PollResult, FeedError, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    yield* reconcileInventory(token, entities);
    yield* refreshWantedEntities(token, entities);
    return {};
  });
