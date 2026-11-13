/**
 * Reads the blocks the Inbox pane draws for one pull request or issue: what
 * the change adds up to, the checks that need attention, the description and
 * a few facts the kind does not declare as fields. One GraphQL request, sent
 * when the pane opens. Nothing is stored.
 */
import { Effect, Schema } from "effect";
import type * as HttpClient from "effect/http/HttpClient";
import { PluginError, type EntityBlockDraft } from "@hercule/plugin-host";
import { isFailedConclusion, isPassingConclusion } from "./github-objects";
import { decodeGithubValue, fetchGraphql, type FeedError } from "./ingest/requests";
import { buildChangeBlock, buildChecksBlock, type CheckToShow } from "./signal-kinds";
import { parseItemRef, splitRepoName, type GithubItem } from "./subject";
import { cutText } from "./text";

/** The longest markdown a text block holds. The contract's limit, which a plugin cannot import. */
const MAX_TEXT_BLOCK_LENGTH = 32 * 1024;

/** The line that ends a description that was cut. */
const CUT_NOTICE = "\n\n_The description is longer than this. Open it on GitHub to read the rest._";

/** How many checks of the latest commit one read lists. The counts cover all of them. */
const CHECKS_READ = 100;

/** Reads the fields of a pull request that the blocks show. */
const PULL_REQUEST_SELECTION = `... on PullRequest {
  body headRefName baseRefName changedFiles additions deletions
  commits(last: 1) { totalCount nodes { commit { statusCheckRollup {
    contexts(first: ${String(CHECKS_READ)}) {
    checkRunCountsByState { state count }
    statusContextCountsByState { state count }
    nodes {
      __typename
      ... on CheckRun { name status conclusion detailsUrl }
      ... on StatusContext { context state targetUrl }
    } }
  } } } }
}`;

/** Reads the fields of an issue that the blocks show. */
const ISSUE_SELECTION = `... on Issue {
  body
  comments { totalCount }
  milestone { title }
}`;

const CheckContext = Schema.Union([
  Schema.Struct({
    __typename: Schema.Literal("CheckRun"),
    name: Schema.String,
    /** `COMPLETED`, `IN_PROGRESS`, `QUEUED`, ... */
    status: Schema.String,
    /** Null until the run completes. `SUCCESS`, `FAILURE`, `TIMED_OUT`, ... */
    conclusion: Schema.NullOr(Schema.String),
    detailsUrl: Schema.NullOr(Schema.String),
  }),
  Schema.Struct({
    __typename: Schema.Literal("StatusContext"),
    context: Schema.String,
    /** `SUCCESS`, `FAILURE`, `ERROR`, `PENDING` or `EXPECTED`. */
    state: Schema.String,
    targetUrl: Schema.NullOr(Schema.String),
  }),
]);

/** How many checks of the latest commit are in one state, such as `SUCCESS` or `QUEUED`. */
const StateCount = Schema.Struct({ state: Schema.String, count: Schema.Int });

const PullRequestBlocksNode = Schema.Struct({
  body: Schema.String,
  headRefName: Schema.String,
  baseRefName: Schema.String,
  changedFiles: Schema.Int,
  additions: Schema.Int,
  deletions: Schema.Int,
  commits: Schema.Struct({
    totalCount: Schema.Int,
    nodes: Schema.NullOr(
      Schema.Array(
        Schema.NullOr(
          Schema.Struct({
            commit: Schema.Struct({
              statusCheckRollup: Schema.NullOr(
                Schema.Struct({
                  contexts: Schema.Struct({
                    checkRunCountsByState: Schema.NullOr(Schema.Array(StateCount)),
                    statusContextCountsByState: Schema.NullOr(Schema.Array(StateCount)),
                    nodes: Schema.NullOr(Schema.Array(Schema.NullOr(CheckContext))),
                  }),
                }),
              ),
            }),
          }),
        ),
      ),
    ),
  }),
});

const IssueBlocksNode = Schema.Struct({
  body: Schema.String,
  comments: Schema.Struct({ totalCount: Schema.Int }),
  milestone: Schema.NullOr(Schema.Struct({ title: Schema.String })),
});

/** A check of the latest commit, in the words `buildChecksBlock` reads. */
interface LatestCheck extends CheckToShow {
  readonly conclusion: string | null;
}

/**
 * Converts a check of the latest commit into one shape. A status that is
 * `PENDING` or `EXPECTED` has not finished. Any other status has finished,
 * and `SUCCESS` is the only one that passed.
 */
const convertCheck = (context: typeof CheckContext.Type): LatestCheck => {
  if (context.__typename === "CheckRun") {
    return {
      name: context.name,
      status: context.status.toLowerCase(),
      conclusion: context.conclusion?.toLowerCase() ?? null,
      html_url: context.detailsUrl,
    };
  }
  const finished = context.state !== "PENDING" && context.state !== "EXPECTED";
  return {
    name: context.context,
    status: finished ? "completed" : "pending",
    conclusion: finished ? context.state.toLowerCase() : null,
    html_url: context.targetUrl,
  };
};

/** The states of a check that has not finished. */
const UNFINISHED_STATES: ReadonlySet<string> = new Set([
  "in_progress",
  "pending",
  "queued",
  "waiting",
  "expected",
]);

/**
 * Adds up the counts GitHub gives for all checks of the latest commit, not
 * only the ones the read lists. A state that is neither passing nor
 * unfinished counts as failed.
 */
const sumCheckCounts = (counts: ReadonlyArray<typeof StateCount.Type>) => {
  const total = { passed: 0, failed: 0, pending: 0 };
  for (const { state, count } of counts) {
    const word = state.toLowerCase();
    if (UNFINISHED_STATES.has(word)) total.pending += count;
    else if (isPassingConclusion(word)) total.passed += count;
    else total.failed += count;
  }
  return total;
};

/** Returns the description as a text block, or no block for an empty description. A long one is cut and says so. */
const buildDescriptionBlocks = (body: string): ReadonlyArray<EntityBlockDraft> => {
  const description = body.trim();
  if (description === "") return [];
  const markdown =
    description.length <= MAX_TEXT_BLOCK_LENGTH
      ? description
      : cutText(description, MAX_TEXT_BLOCK_LENGTH - CUT_NOTICE.length) + CUT_NOTICE;
  return [{ type: "text", markdown }];
};

/**
 * Returns the blocks of a pull request: the change, with the counts of its
 * latest commit's checks, then the checks that failed or have not finished,
 * then the description.
 */
const buildPullRequestBlocks = (
  node: typeof PullRequestBlocksNode.Type,
): ReadonlyArray<EntityBlockDraft> => {
  const rollup = node.commits.nodes?.[0]?.commit.statusCheckRollup;
  const listed = (rollup?.contexts.nodes ?? []).flatMap((context) =>
    context === null ? [] : [convertCheck(context)],
  );
  const failed = listed.filter((check) => isFailedConclusion(check.conclusion));
  const pending = listed.filter((check) => check.status !== "completed");
  const totals = sumCheckCounts([
    ...(rollup?.contexts.checkRunCountsByState ?? []),
    ...(rollup?.contexts.statusContextCountsByState ?? []),
  ]);
  return [
    buildChangeBlock({
      from: node.headRefName,
      to: node.baseRefName,
      files: node.changedFiles,
      additions: node.additions,
      deletions: node.deletions,
      commits: node.commits.totalCount,
      ...(totals.passed + totals.failed + totals.pending === 0 ? {} : { checks: totals }),
    }),
    ...(totals.failed + totals.pending === 0
      ? []
      : [
          buildChecksBlock(
            {
              failed,
              pending,
              passed: totals.passed,
              unlisted: Math.max(
                0,
                totals.failed + totals.pending - failed.length - pending.length,
              ),
            },
            () => undefined,
          ),
        ]),
    ...buildDescriptionBlocks(node.body),
  ];
};

/** Returns the blocks of an issue: its description, then its milestone and comment count. */
const buildIssueBlocks = (node: typeof IssueBlocksNode.Type): ReadonlyArray<EntityBlockDraft> => {
  const rows = [
    ...(node.milestone === null
      ? []
      : [{ label: "Milestone", value: cutText(node.milestone.title, 200) }]),
    ...(node.comments.totalCount === 0
      ? []
      : [{ label: "Comments", value: String(node.comments.totalCount) }]),
  ];
  return [
    ...buildDescriptionBlocks(node.body),
    ...(rows.length === 0 ? [] : [{ type: "fields", rows }]),
  ];
};

/**
 * Reads the blocks of the pull request or issue `ref` names, in one GraphQL
 * request. Fails as `fetchGraphql` fails, and with a `PluginError` when `ref`
 * is not a pull request or an issue, or when GitHub answers `null`: GitHub
 * says the same for a thing that does not exist and for one the token may
 * not see.
 */
export const readItemBlocks = (
  token: string,
  ref: string,
): Effect.Effect<ReadonlyArray<EntityBlockDraft>, FeedError, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const item: Pick<GithubItem, "repo" | "kind" | "number"> | undefined = parseItemRef(ref);
    if (item === undefined) {
      return yield* new PluginError({
        message: `GitHub shows the body of a pull request or an issue, and ${ref} is neither.`,
      });
    }
    const { owner, name } = splitRepoName(item.repo);
    const [field, selection] =
      item.kind === "pr"
        ? (["pullRequest", PULL_REQUEST_SELECTION] as const)
        : (["issue", ISSUE_SELECTION] as const);
    const query = `query ($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) { ${field}(number: $number) { ${selection} } }
}`;
    const data = yield* fetchGraphql(
      token,
      query,
      { owner, name, number: item.number },
      { tolerateMissing: true },
    );
    const answer = yield* decodeGithubValue(
      Schema.Struct({ repository: Schema.NullOr(Schema.Record(Schema.String, Schema.Unknown)) }),
      data,
      "an item",
    );
    const node = answer.repository?.[field];
    if (node === null || node === undefined) {
      return yield* new PluginError({
        message: `GitHub could not find ${ref}. It may be deleted, or this Connection's token may not see it.`,
      });
    }
    return item.kind === "pr"
      ? buildPullRequestBlocks(
          yield* decodeGithubValue(PullRequestBlocksNode, node, "a pull request"),
        )
      : buildIssueBlocks(yield* decodeGithubValue(IssueBlocksNode, node, "an issue"));
  });
