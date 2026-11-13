/**
 * How the Add button on Work finds Linear things: it recognizes an issue in
 * pasted text, searches Linear by words, and reads one issue. The
 * observations it returns are the ones the `entities` feed reports
 * (`entity-reads.ts`), so a thing reads the same whichever way it was found.
 *
 * A Linear address or identifier holds no workspace id, so it never names a
 * canonical ref by itself. Recognition gives a scoped recognition, and
 * `resolve` reads the identifier on a Connection to find the ref.
 */
import { Effect, Schema } from "effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import type * as HttpClient from "effect/http/HttpClient";
import {
  AuthError,
  PluginError,
  type EntityLookup,
  type EntityLookupContext,
  type EntityObservation,
  type EntityBlockDraft,
  type EntityRecognition,
  type EntityResolution,
} from "@hercule/plugin-host";
import { buildAuthorization, callLinear, MAX_PAGE_SIZE, type LinearFailure } from "./api";
import { INITIATIVE_KIND, ISSUE_KIND, PROJECT_KIND, TEAM_KIND } from "./entity-kinds";
import { buildIssueObservation, parseRef } from "./entity-reads";
import { buildDescriptionTextBlocks } from "./signal-kinds";
import { cutName, cutText, MAX_BODY_LENGTH } from "./text";
import {
  ApiIssue,
  buildDescription,
  ISSUE_FRAGMENT,
  ISSUE_SEARCH_FRAGMENT,
  VIEWER_FIELDS,
  ViewerFields,
} from "./linear-objects";

/** The most things `recognize` returns for one text. */
const MAX_RECOGNITIONS = 20;

/**
 * A team's key and an issue's number, such as `SHOP-123`: letters and digits
 * starting with a letter, a dash, and at most nine digits (a number Linear's
 * `Float` filters hold exactly). Linear writes the key in capitals, but an
 * address may carry it in lower case.
 */
const IDENTIFIER_SOURCE = "[A-Za-z][A-Za-z0-9]{1,6}-\\d{1,9}";

/** The same, for text that is not an address: capitals only, because words such as `utf-8` are not issues. */
const BARE_IDENTIFIER_SOURCE = "[A-Z][A-Z0-9]{1,6}-\\d{1,9}";

/**
 * Matches, in order, the two ways a text names one issue: a web address
 * (`https://linear.app/acme/issue/SHOP-123/the-title`) and an identifier
 * (`SHOP-123`). The identifier may not start inside a longer word or path, so
 * the identifier of an address is not read twice.
 */
const MENTION = new RegExp(
  `https://linear\\.app/([A-Za-z0-9_-]+)/issue/(${IDENTIFIER_SOURCE})(?![\\w-])` +
    `|(?<![\\w/.-])(${BARE_IDENTIFIER_SOURCE})(?![\\w-])`,
  "g",
);

/** Matches a whole text that is one identifier. Case does not matter here: the user is typing it. */
const IDENTIFIER = /^([A-Z][A-Z0-9]{1,6})-(\d{1,9})$/i;

/**
 * Returns the issues `text` names, in order, each once, at most 20. A web
 * address gives a scoped recognition whose `scopeHint` is the workspace's
 * `urlKey`. A bare identifier is scoped with no hint, and only a bare
 * identifier in capitals counts. Reads no page and needs no credentials.
 */
export const recognizeLinearIssues = (text: string): ReadonlyArray<EntityRecognition> => {
  const recognitions: Array<EntityRecognition> = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(MENTION)) {
    if (recognitions.length === MAX_RECOGNITIONS) break;
    const [, urlKey, urlIdentifier, bareIdentifier] = match;
    const identifier = (urlIdentifier ?? bareIdentifier ?? "").toUpperCase();
    const key = `${urlKey ?? ""}/${identifier}`;
    if (seen.has(key)) continue;
    seen.add(key);
    recognitions.push(
      urlKey === undefined
        ? { recognized: "scoped", form: "identifier", kind: ISSUE_KIND, identifier }
        : { recognized: "scoped", form: "url", kind: ISSUE_KIND, identifier, scopeHint: urlKey },
    );
  }
  return recognitions;
};

/** The issues a search or a read found, with the workspace and the user it was read as. */
const IssueNodes = Schema.Struct({ nodes: Schema.Array(ApiIssue) });

const SEARCH_QUERY = `query LinearSearchIssues($term: String!, $filter: IssueFilter, $first: Int) {
  searchIssues(term: $term, filter: $filter, first: $first) {
    nodes { ...IssueSearchFields }
  }
  ${VIEWER_FIELDS}
}
${ISSUE_SEARCH_FRAGMENT}`;

const SearchAnswer = Schema.Struct({ ...ViewerFields, searchIssues: IssueNodes });

const READ_QUERY = `query LinearReadIssue($filter: IssueFilter) {
  issues(filter: $filter, first: 1, includeArchived: true) {
    nodes { ...IssueFields }
  }
  ${VIEWER_FIELDS}
}
${ISSUE_FRAGMENT}`;

const ReadAnswer = Schema.Struct({ ...ViewerFields, issues: IssueNodes });

/**
 * Returns the issue filter that narrows a search to the context a `scopeRef`
 * names: a team, a project, or the projects of an initiative. Fails with a
 * `PluginError` for a ref that is none of these, because a scope the source
 * cannot search by must not widen the search.
 */
export const buildScopeFilter = (
  scopeRef: string,
): Effect.Effect<Readonly<Record<string, unknown>>, PluginError> => {
  const scope = parseRef(scopeRef);
  switch (scope?.kind) {
    case TEAM_KIND:
      return Effect.succeed({ team: { id: { eq: scope.id } } });
    case PROJECT_KIND:
      return Effect.succeed({ project: { id: { eq: scope.id } } });
    case INITIATIVE_KIND:
      return Effect.succeed({ project: { initiatives: { some: { id: { eq: scope.id } } } } });
    default:
      return Effect.fail(
        new PluginError({
          message: `Linear can search only inside a team, a project or an initiative, and ${scopeRef} is not one.`,
        }),
      );
  }
};

/**
 * Searches issues by words or an identifier, at most `limit`, in one request.
 * With a `scopeRef`, the search is narrowed to that team, project or
 * initiative. Fails as `callLinear` does, and with a `PluginError` when
 * `scopeRef` names something Linear cannot search inside.
 */
export const searchIssues = (
  authorization: string,
  query: { readonly text: string; readonly scopeRef?: string; readonly limit: number },
): Effect.Effect<ReadonlyArray<EntityObservation>, LinearFailure, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const filter = query.scopeRef === undefined ? null : yield* buildScopeFilter(query.scopeRef);
    const answer = yield* callLinear(
      authorization,
      {
        name: "LinearSearchIssues",
        text: SEARCH_QUERY,
        variables: { term: query.text, filter, first: Math.min(query.limit, MAX_PAGE_SIZE) },
      },
      SearchAnswer,
    );
    return answer.searchIssues.nodes
      .slice(0, query.limit)
      .map((issue) => buildIssueObservation(issue, answer.organization, answer.viewer.id, []));
  });

/**
 * Reads the issue a recognition names. Returns:
 *
 * - `outOfScope` when the recognition's `scopeHint` is not this workspace's
 *   `urlKey`;
 * - `missing: "inaccessible"` for a ref of another workspace;
 * - `missing: "unknown"` when Linear returns no issue, because Linear answers
 *   the same for an issue that does not exist and for one the user may not see.
 *
 * Fails as `callLinear` does, and with a `PluginError` for a ref that is not an
 * issue's or an identifier that is not `KEY-123`.
 */
export const resolveIssue = (
  authorization: string,
  target: EntityRecognition,
): Effect.Effect<EntityResolution, LinearFailure, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    let filter: Readonly<Record<string, unknown>>;
    if (target.recognized === "ref") {
      const parsed = parseRef(target.ref);
      if (parsed?.kind !== ISSUE_KIND) {
        return yield* new PluginError({
          message: `Linear reads issues, and ${target.ref} is not an issue's ref.`,
        });
      }
      filter = { id: { in: [parsed.id] } };
    } else {
      const match = IDENTIFIER.exec(target.identifier);
      if (match === null) {
        return yield* new PluginError({
          message: `Linear reads an issue written KEY-123, and ${target.identifier} is not.`,
        });
      }
      filter = { team: { key: { eq: match[1]!.toUpperCase() } }, number: { eq: Number(match[2]) } };
    }
    const answer = yield* callLinear(
      authorization,
      { name: "LinearReadIssue", text: READ_QUERY, variables: { filter } },
      ReadAnswer,
    );
    const { organization, viewer } = answer;
    if (
      target.recognized === "scoped" &&
      target.scopeHint !== undefined &&
      target.scopeHint.toLowerCase() !== organization.urlKey.toLowerCase()
    ) {
      return { outOfScope: true as const };
    }
    if (target.recognized === "ref" && parseRef(target.ref)?.workspaceId !== organization.id) {
      return { missing: "inaccessible" as const };
    }
    const issue = answer.issues.nodes[0];
    return issue === undefined
      ? { missing: "unknown" as const }
      : { found: buildIssueObservation(issue, organization, viewer.id, []) };
  });

/** The longest value a `fields` block row takes. */
const MAX_FIELD_VALUE_LENGTH = 200;

/** Appended to a description that was cut, so the pane says it is not the whole text. */
const DESCRIPTION_CUT_NOTE =
  "\n\n*The description is cut here. Open the issue in Linear for the rest.*";

/**
 * Builds the `fields` block of the facts about an issue that its kind does
 * not declare as fields: labels, due date, estimate and creator. Returns no
 * block when the issue has none of them.
 */
const buildExtraFieldsBlocks = (issue: ApiIssue): ReadonlyArray<EntityBlockDraft> => {
  const rows = [
    ["Labels", issue.labels.nodes.map((label) => cutName(label.name)).join(", ")],
    ["Due", issue.dueDate ?? ""],
    ["Estimate", issue.estimate === null ? "" : String(issue.estimate)],
    ["Creator", issue.creator === null ? "" : cutName(issue.creator.name)],
  ]
    .filter(([, value]) => value !== "")
    .map(([label, value]) => ({ label, value: cutText(value!, MAX_FIELD_VALUE_LENGTH) }));
  return rows.length === 0 ? [] : [{ type: "fields", rows }];
};

/**
 * Reads the issue a ref names in one request and returns the blocks the
 * Inbox pane draws for it: a `fields` block with the facts its kind does not
 * declare, then its description as a `text` block. A description past the
 * plugin's limit is cut and says so.
 *
 * Fails as `callLinear` does, with a `PluginError` for a ref that is not an
 * issue's, and with a `PluginError` when Linear returns no issue, because
 * Linear answers the same for a missing issue and one the user may not see.
 */
export const readIssueBlocks = (
  authorization: string,
  ref: string,
): Effect.Effect<ReadonlyArray<EntityBlockDraft>, LinearFailure, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const parsed = parseRef(ref);
    if (parsed?.kind !== ISSUE_KIND) {
      return yield* new PluginError({
        message: `Linear reads blocks for issues, and ${ref} is not an issue's ref.`,
      });
    }
    const answer = yield* callLinear(
      authorization,
      {
        name: "LinearReadIssue",
        text: READ_QUERY,
        variables: { filter: { id: { in: [parsed.id] } } },
      },
      ReadAnswer,
    );
    const issue = answer.issues.nodes[0];
    if (issue === undefined || parsed.workspaceId !== answer.organization.id) {
      return yield* new PluginError({
        message: `Linear returned no issue for ${ref}. It may be deleted, or you may no longer see it.`,
      });
    }
    const cut = issue.description !== null && issue.description.length > MAX_BODY_LENGTH;
    const [description] = buildDescriptionTextBlocks(buildDescription(issue));
    return [
      ...buildExtraFieldsBlocks(issue),
      ...(description === undefined
        ? []
        : [
            {
              ...description,
              title: "Description",
              markdown: cut ? description.markdown + DESCRIPTION_CUT_NOTE : description.markdown,
            },
          ]),
    ];
  });

/**
 * Runs `use` with the Connection's `Authorization` header and a fetch client.
 * A rate limit is a `PluginError` here, because a lookup has no way to wait.
 */
const withAuthorization = <A>(
  context: EntityLookupContext,
  use: (authorization: string) => Effect.Effect<A, LinearFailure, HttpClient.HttpClient>,
): Effect.Effect<A, AuthError | PluginError> =>
  context.credentials().pipe(
    Effect.mapError((error) => new PluginError({ message: error.message })),
    Effect.flatMap((credentials) => {
      const authorization = buildAuthorization(credentials);
      return authorization === undefined
        ? Effect.fail(
            new AuthError({
              message:
                "The Connection has no Linear credential. Reconnect it to sign in to Linear again.",
            }),
          )
        : use(authorization);
    }),
    Effect.catchTag("LinearRateLimited", (limit) =>
      Effect.fail(
        new PluginError({
          message: `Linear is limiting how fast this Connection may ask. Try again in ${String(limit.retryAfterSeconds)} seconds.`,
        }),
      ),
    ),
    Effect.provide(FetchHttpClient.layer),
  );

export const linearEntityLookup: EntityLookup = {
  recognize: recognizeLinearIssues,
  search: (_connection, context, query) =>
    withAuthorization(context, (authorization) => searchIssues(authorization, query)),
  resolve: (_connection, context, target) =>
    withAuthorization(context, (authorization) => resolveIssue(authorization, target)),
  readBlocks: (_connection, context, ref) =>
    withAuthorization(context, (authorization) => readIssueBlocks(authorization, ref)),
};
