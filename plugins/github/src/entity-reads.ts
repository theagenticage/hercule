/**
 * Reads pull requests, issues and repositories from GitHub's GraphQL API and
 * builds their External Entity observations. The `entities` feed
 * (`ingest/entities.ts`) and the Add button's lookup (`entity-lookup.ts`)
 * share it, so a thing reads the same whichever way it was found. It has two
 * reads: `readTargets` for named things and `readSearchPage` for a search.
 * The callers decide how many pages to read and what a missing answer means.
 *
 * The plugin reports raw `fields` and a status key. The tables in
 * `entity-kinds.ts` say how a card shows them.
 */
import { Effect, Schema } from "effect";
import type * as HttpClient from "effect/http/HttpClient";
import {
  MAX_ENTITY_TEXT_LENGTH,
  MAX_EVENT_TITLE_LENGTH,
  type EntityObservation,
  type PluginError,
  type TrackedBranch,
} from "@hercule/plugin-host";
import { ISSUE_KIND, PULL_REQUEST_KIND, REPOSITORY_KIND } from "./entity-kinds";
import { decodeGithubValue, fetchGraphql, type FeedError } from "./ingest/requests";
import {
  buildItemRef,
  buildRepoRef,
  buildRepoSubject,
  parseItemRef,
  parseRepoRef,
  splitRepoName,
} from "./subject";
import { cutText } from "./text";

/** How many assignees of an issue one read lists. */
const ASSIGNEES_READ = 5;

/** The concerns the `entities` feed reports. The host sets the others. */
export type EntityConcern = "opened" | "review-requested" | "assigned";

// ---------------------------------------------------------------------------
// What GitHub sends
// ---------------------------------------------------------------------------

/** The GraphQL fields of a repository, as a named fragment. The two item fragments spread it. */
const REPOSITORY_FRAGMENT = `fragment RepositoryFields on Repository { nameWithOwner createdAt }`;

const PULL_REQUEST_FRAGMENT = `fragment PullRequestFields on PullRequest {
  __typename number title url bodyText isDraft state updatedAt
  author { login }
  repository { ...RepositoryFields }
  headRefName
  headRepository { nameWithOwner }
  reviewDecision additions deletions changedFiles
  commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
}`;

const ISSUE_FRAGMENT = `fragment IssueFields on Issue {
  __typename number title url bodyText state stateReason updatedAt
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
const buildFragments = (spreads: {
  readonly pullRequest: boolean;
  readonly issue: boolean;
}): string =>
  [
    REPOSITORY_FRAGMENT,
    ...(spreads.pullRequest ? [PULL_REQUEST_FRAGMENT] : []),
    ...(spreads.issue ? [ISSUE_FRAGMENT] : []),
  ].join("\n");

/** The fragments of a query that spreads both item fragments, as a search and a lookup do. */
const ITEM_FRAGMENTS = buildFragments({ pullRequest: true, issue: true });

const RepositoryNode = Schema.Struct({
  nameWithOwner: Schema.String,
  createdAt: Schema.String,
});

export type RepositoryNode = Schema.Schema.Type<typeof RepositoryNode>;

/** An account, or null for one GitHub deleted. */
const AccountNode = Schema.NullOr(Schema.Struct({ login: Schema.String }));

const PullRequestNode = Schema.Struct({
  __typename: Schema.Literal("PullRequest"),
  number: Schema.Int,
  title: Schema.String,
  url: Schema.String,
  /** The description as plain text, which may be empty. */
  bodyText: Schema.String,
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
  /** The description as plain text, which may be empty. */
  bodyText: Schema.String,
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
const ViewerNode = Schema.Struct({ login: Schema.String });

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

/**
 * Returns the `texts` of an item: its description, which the host searches for
 * references to other things. An empty description reports an empty text,
 * which clears the hints its old description left.
 */
const buildItemTexts = (node: ItemNode): Pick<EntityObservation, "texts"> => ({
  texts: [
    {
      evidenceKey: "description",
      text: node.bodyText.trim() === "" ? "" : cutText(node.bodyText, MAX_ENTITY_TEXT_LENGTH),
      revision: node.updatedAt,
    },
  ],
});

/** What every address of a repository on GitHub starts with, as the core stores a remote. */
export const GITHUB_REMOTE_PREFIX = "github.com/";

/** Returns the address of a repository the way a plugin reports it: `github.com/owner/repo`, lowercase. */
const buildRemote = (nameWithOwner: string): string =>
  `${GITHUB_REMOTE_PREFIX}${nameWithOwner.toLowerCase()}`;

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
const buildPullRequestObservation = (
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
    ...buildItemTexts(node),
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
const MAX_LABELS_FACT_LENGTH = 80;

/**
 * Returns the label names as one line for the `labels` fact: as many whole
 * names as fit, comma separated, and when some are left out, a closing count
 * such as "bug, checkout +2". Returns null for no labels. The line is never
 * longer than `MAX_LABELS_FACT_LENGTH`.
 */
const summarizeLabels = (names: ReadonlyArray<string>): string | null => {
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
const buildIssueObservation = (
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
    ...buildItemTexts(node),
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
export const buildRepositoryObservation = (repository: RepositoryNode): EntityObservation => ({
  kind: REPOSITORY_KIND,
  ref: buildRepoRef(repository.nameWithOwner),
  title: repository.nameWithOwner,
  url: buildRepoSubject(repository.nameWithOwner).url,
  fields: { name: repository.nameWithOwner },
  concerns: [],
  sourceUpdatedAt: repository.createdAt,
});

/** One thing to read. An `item` is a pull request or an issue, whichever the number names. */
export type ReadTarget =
  | { readonly kind: "pr" | "issue" | "item"; readonly repo: string; readonly number: number }
  | { readonly kind: "repo"; readonly repo: string };

/** The GraphQL field of a repository that returns each kind of item, and the fragments that field spreads. */
const ITEM_SELECTIONS = {
  pr: { field: "pullRequest", spreads: "...PullRequestFields" },
  issue: { field: "issue", spreads: "...IssueFields" },
  item: { field: "issueOrPullRequest", spreads: "...PullRequestFields ...IssueFields" },
} as const;

/**
 * Returns the GraphQL selection that reads `target` under the alias
 * `t<index>`. The owner, name and number are variables `$o<index>`,
 * `$n<index>` and `$i<index>`, never text pasted into the query.
 */
const buildSelection = (target: ReadTarget, index: number): string => {
  const repository = `t${String(index)}: repository(owner: $o${String(index)}, name: $n${String(index)})`;
  if (target.kind === "repo") return `${repository} { ...RepositoryFields }`;
  const { field, spreads } = ITEM_SELECTIONS[target.kind];
  return `${repository} { ${field}(number: $i${String(index)}) { ${spreads} } }`;
};

/** Turns the answer to one alias into an observation, or undefined when GitHub answered `null`. */
const decodeTargetAnswer = (
  target: ReadTarget,
  value: unknown,
  viewerLogin: string,
): Effect.Effect<EntityObservation | undefined, PluginError> => {
  if (target.kind === "repo") {
    return Effect.map(
      decodeGithubValue(Schema.NullOr(RepositoryNode), value, "a repository"),
      (repository) => (repository === null ? undefined : buildRepositoryObservation(repository)),
    );
  }
  const { field } = ITEM_SELECTIONS[target.kind];
  return Effect.map(
    decodeGithubValue(
      Schema.NullOr(Schema.Record(Schema.String, Schema.NullOr(ItemNode))),
      value,
      "an item",
    ),
    (answer) => {
      const node = answer?.[field];
      return node == null ? undefined : buildItemObservation(node, viewerLogin, []);
    },
  );
};

/**
 * Reads `targets` in one GraphQL request with one alias per target, and
 * returns one entry per target, in order: its observation, or undefined when
 * GitHub answers `null` (deleted, or not visible to the token). GitHub says
 * the same for both, so the callers decide what undefined means. Sends no
 * request for no targets. Fails as `fetchGraphql` fails.
 */
export const readTargets = (
  token: string,
  targets: ReadonlyArray<ReadTarget>,
): Effect.Effect<ReadonlyArray<EntityObservation | undefined>, FeedError, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    if (targets.length === 0) return [];

    const declarations: Array<string> = [];
    const variables: Record<string, string | number> = {};
    for (const [index, target] of targets.entries()) {
      const { owner, name } = splitRepoName(target.repo);
      declarations.push(`$o${String(index)}: String!`, `$n${String(index)}: String!`);
      variables[`o${String(index)}`] = owner;
      variables[`n${String(index)}`] = name;
      if (target.kind !== "repo") {
        declarations.push(`$i${String(index)}: Int!`);
        variables[`i${String(index)}`] = target.number;
      }
    }
    const selections = targets.map(buildSelection);
    const fragments = buildFragments({
      pullRequest: targets.some(({ kind }) => kind === "pr" || kind === "item"),
      issue: targets.some(({ kind }) => kind === "issue" || kind === "item"),
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
      "the things asked for",
    );
    const viewer = yield* decodeGithubValue(ViewerNode, answer["viewer"], "the viewer");
    const observations: Array<EntityObservation | undefined> = [];
    for (const [index, target] of targets.entries()) {
      observations.push(
        yield* decodeTargetAnswer(target, answer[`t${String(index)}`], viewer.login),
      );
    }
    return observations;
  });

/** How many pull requests of one branch a read lists, newest first. A branch rarely has more. */
const PULL_REQUESTS_PER_BRANCH = 5;

const BranchPullRequestsAnswer = Schema.NullOr(
  Schema.Struct({
    pullRequests: Schema.Struct({
      nodes: Schema.NullOr(Schema.Array(Schema.NullOr(PullRequestNode))),
    }),
  }),
);

/**
 * Returns the owner and name of the repository a remote such as
 * `github.com/owner/repo` names, or undefined for an address that is not a
 * GitHub repository GitHub would allow.
 */
const parseGithubRemote = (remote: string): { owner: string; name: string } | undefined => {
  if (!remote.startsWith(GITHUB_REMOTE_PREFIX)) return undefined;
  const repo = parseRepoRef(`github:repo:${remote.slice(GITHUB_REMOTE_PREFIX.length)}`);
  return repo === undefined ? undefined : splitRepoName(repo);
};

/**
 * Reads, in one request with one alias per branch, the pull requests whose
 * head is each of `branches`, open, merged or closed, and returns their
 * observations with no concerns. A pull request is kept only when its head
 * lives on the branch's own remote, so a fork's pull request that happens to
 * use the same branch name is left out. A branch on an address that is not a
 * GitHub repository is skipped. Sends no request when no branch is left.
 * Fails as `fetchGraphql` fails.
 */
export const readPullRequestsByBranch = (
  token: string,
  branches: ReadonlyArray<TrackedBranch>,
): Effect.Effect<ReadonlyArray<EntityObservation>, FeedError, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const readable = branches.flatMap((branch) => {
      const repository = parseGithubRemote(branch.remote);
      return repository === undefined ? [] : [{ ...branch, ...repository }];
    });
    if (readable.length === 0) return [];

    const declarations: Array<string> = [];
    const variables: Record<string, string> = {};
    const selections: Array<string> = [];
    for (const [index, { owner, name, branch }] of readable.entries()) {
      const i = String(index);
      declarations.push(`$o${i}: String!`, `$n${i}: String!`, `$b${i}: String!`);
      variables[`o${i}`] = owner;
      variables[`n${i}`] = name;
      variables[`b${i}`] = branch;
      selections.push(
        `b${i}: repository(owner: $o${i}, name: $n${i}) { pullRequests(headRefName: $b${i}, first: ${String(PULL_REQUESTS_PER_BRANCH)}, states: [OPEN, MERGED, CLOSED], orderBy: { field: CREATED_AT, direction: DESC }) { nodes { ...PullRequestFields } } }`,
      );
    }
    const query = `query (${declarations.join(", ")}) {
  viewer { login }
  ${selections.join("\n  ")}
}
${buildFragments({ pullRequest: true, issue: false })}`;

    const data = yield* fetchGraphql(token, query, variables, { tolerateMissing: true });
    const answer = yield* decodeGithubValue(
      Schema.Record(Schema.String, Schema.Unknown),
      data,
      "the branches asked for",
    );
    const viewer = yield* decodeGithubValue(ViewerNode, answer["viewer"], "the viewer");
    const observations: Array<EntityObservation> = [];
    for (const [index, { remote }] of readable.entries()) {
      const nodes = (yield* decodeGithubValue(
        BranchPullRequestsAnswer,
        answer[`b${String(index)}`],
        "the pull requests of a branch",
      ))?.pullRequests.nodes;
      for (const node of nodes ?? []) {
        if (node === null || node.headRepository === null) continue;
        if (buildRemote(node.headRepository.nameWithOwner) !== remote) continue;
        observations.push(buildPullRequestObservation(node, viewer.login, []));
      }
    }
    return observations;
  });

/** Parses a ref this plugin built, or returns undefined for one it cannot read. */
const parseRefTarget = (ref: string): ReadTarget | undefined => {
  const item = parseItemRef(ref);
  if (item !== undefined) return item;
  const repo = parseRepoRef(ref);
  return repo === undefined ? undefined : { kind: "repo", repo };
};

/**
 * Reads the pull requests, issues and repositories that `refs` name, in one
 * request (`readTargets`). A ref that names nothing this plugin can read, or
 * that GitHub answers with `null`, is `missing`. Fails as `fetchGraphql` fails.
 */
export const readEntitiesByRef = (
  token: string,
  refs: ReadonlyArray<string>,
): Effect.Effect<
  {
    readonly observations: ReadonlyArray<EntityObservation>;
    readonly missing: ReadonlyArray<string>;
  },
  FeedError,
  HttpClient.HttpClient
> =>
  Effect.gen(function* () {
    const readable = refs.flatMap((ref) => {
      const target = parseRefTarget(ref);
      return target === undefined ? [] : [{ ref, target }];
    });
    const answers = yield* readTargets(
      token,
      readable.map(({ target }) => target),
    );
    const observations = answers.flatMap((answer) => (answer === undefined ? [] : [answer]));
    const answered = new Set(
      readable.filter((_, index) => answers[index] !== undefined).map(({ ref }) => ref),
    );
    return { observations, missing: refs.filter((ref) => !answered.has(ref)) };
  });

const SEARCH_QUERY = `
query ($query: String!, $first: Int!, $after: String) {
  viewer { login }
  search(query: $query, type: ISSUE, first: $first, after: $after) {
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

export type SearchPage = Schema.Schema.Type<typeof SearchPage>;

/**
 * Reads one page of a search for pull requests and issues: the `first`
 * results after the cursor `after`, or the best ones when `after` is null.
 * The nodes are not turned into observations, because the feed adds the
 * concerns of the search that found them (`buildItemObservation`). Fails as
 * `fetchGraphql` fails.
 */
export const readSearchPage = (
  token: string,
  search: { readonly query: string; readonly first: number; readonly after: string | null },
): Effect.Effect<SearchPage, FeedError, HttpClient.HttpClient> =>
  Effect.flatMap(fetchGraphql(token, SEARCH_QUERY, search), (data) =>
    decodeGithubValue(SearchPage, data, "a page of search results"),
  );
