/**
 * How the Add button on Work finds Sentry things: it recognizes an issue in
 * pasted text, searches the organization's issues, and reads one issue. The
 * observations it returns are the ones the `entities` feed reports
 * (`entity-reads.ts`), so an issue reads the same whichever way it was found.
 *
 * A Sentry address or short id holds no organization id, which a ref needs.
 * Recognition therefore gives scoped recognitions, and `resolve` reads them on
 * a Connection to find the ref.
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
  type EntityRecognition,
  type EntityResolution,
} from "@hercule/plugin-host";
import { callSentry, decodeSentryBody, readToken, type SentryFailure } from "./api";
import { readIssueBlocks } from "./entity-blocks";
import { ISSUE_KIND } from "./entity-kinds";
import {
  buildIssueObservation,
  readOrganizationTeams,
  type IssueObservationContext,
} from "./entity-reads";
import { lookUpIssues } from "./ingest/list";
import { readUserId } from "./identity";
import { findOrganization, type OrganizationAccess } from "./organization";
import { parseIssueRef } from "./refs";
import { ApiIssue } from "./sentry-objects";

/** The most things `recognize` returns for one text. */
const MAX_RECOGNITIONS = 20;

/** The most issues one issues-list request returns: the most Sentry allows. */
const MAX_SEARCH_LIMIT = 100;

/** An organization's slug, as it appears in an address. */
const ORGANIZATION_SLUG_SOURCE = "[A-Za-z0-9][A-Za-z0-9-]{0,49}";

/**
 * A short id such as `STOREFRONT-21C`: the project's slug in capitals (it may
 * hold digits and dashes), a dash, and a base-36 suffix in capitals. Only
 * capitals count, because words such as `utf-8` are not issues. The lengths
 * are bounded so a long run of dashes cannot make the match slow.
 */
const SHORT_ID_SOURCE = "[A-Z][A-Z0-9]{1,30}(?:-[A-Z0-9]{1,30}){0,5}-[A-Z0-9]{1,8}";

/**
 * Matches, in order, the three ways a text names one issue: the address
 * `https://<org>.sentry.io/issues/<id>/`, the address
 * `https://sentry.io/organizations/<org>/issues/<id>/`, and a short id. The
 * short id may not start inside a longer word or path, so nothing inside an
 * address is read twice. The address must end its host at `sentry.io`, so
 * `sentry.io.evil.com` and `evil.com/sentry.io/...` match nothing.
 */
const MENTION = new RegExp(
  `https://(${ORGANIZATION_SLUG_SOURCE})\\.sentry\\.io/issues/(\\d{1,18})(?!\\d)` +
    `|https://sentry\\.io/organizations/(${ORGANIZATION_SLUG_SOURCE})/issues/(\\d{1,18})(?!\\d)` +
    `|(?<![\\w/.-])(${SHORT_ID_SOURCE})(?![\\w-])`,
  "g",
);

/** Matches a whole short id. Case does not matter here: the user may type it. */
const SHORT_ID = new RegExp(`^${SHORT_ID_SOURCE}$`, "i");

/**
 * Returns the issues `text` names, in order, each once, at most 20. An address
 * gives a scoped recognition whose `identifier` is the issue's id and whose
 * `scopeHint` is the organization's slug. A short id gives a scoped
 * recognition with no hint. A Linear key such as `SHOP-123` reads as a short
 * id too: each plugin recognizes its own shapes, and the core shows only the
 * ones that resolve. Reads no page and needs no credentials.
 */
export const recognizeSentryIssues = (text: string): ReadonlyArray<EntityRecognition> => {
  const recognitions: Array<EntityRecognition> = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(MENTION)) {
    if (recognitions.length === MAX_RECOGNITIONS) break;
    const [, subdomainSlug, subdomainId, pathSlug, pathId, shortId] = match;
    const organizationSlug = subdomainSlug ?? pathSlug;
    const issueId = subdomainId ?? pathId;
    const key =
      organizationSlug === undefined
        ? `short/${shortId ?? ""}`
        : `url/${organizationSlug.toLowerCase()}/${issueId ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    recognitions.push(
      organizationSlug === undefined
        ? { recognized: "scoped", form: "identifier", kind: ISSUE_KIND, identifier: shortId ?? "" }
        : {
            recognized: "scoped",
            form: "url",
            kind: ISSUE_KIND,
            identifier: issueId ?? "",
            scopeHint: organizationSlug,
          },
    );
  }
  return recognitions;
};

/**
 * Runs `use` with the organization the Connection's credentials reach and a
 * fetch client. Fails with an `AuthError` when the credentials hold no token.
 * A rate limit is a `PluginError` here, because a lookup has no way to wait.
 * Costs one request, to find the organization, besides what `use` sends.
 */
const withOrganizationAccess = <A>(
  context: EntityLookupContext,
  use: (access: OrganizationAccess) => Effect.Effect<A, SentryFailure, HttpClient.HttpClient>,
): Effect.Effect<A, AuthError | PluginError> =>
  context.credentials().pipe(
    Effect.mapError((error) => new PluginError({ message: error.message })),
    Effect.flatMap((credentials) => {
      const token = readToken(credentials);
      return token === undefined
        ? Effect.fail(
            new AuthError({
              message:
                "The Connection has no Sentry token. Reconnect it to sign in to Sentry again.",
            }),
          )
        : findOrganization(token, credentials).pipe(
            Effect.flatMap((organization) => use({ token, organization })),
          );
    }),
    Effect.catchTag("SentryRateLimited", (limit) =>
      Effect.fail(
        new PluginError({
          message: `Sentry is limiting how fast this Connection may ask. Try again in ${String(limit.retryAfterSeconds)} seconds.`,
        }),
      ),
    ),
    Effect.provide(FetchHttpClient.layer),
  );

/**
 * Reads the organization's teams (one request) and returns what an issue's
 * observation needs besides the issue.
 */
const readObservationContext = (
  access: OrganizationAccess,
  accountId: string,
): Effect.Effect<IssueObservationContext, SentryFailure, HttpClient.HttpClient> =>
  Effect.map(readOrganizationTeams(access), (teams) => ({
    organizationId: access.organization.id,
    userId: readUserId(accountId),
    teams,
  }));

/**
 * Searches the organization's issues by words or a short id, at most `limit`,
 * whatever their status. Sends one issues-list request with `shortIdLookup=1`,
 * so a short id in the text comes back alone. With the teams read and the
 * organization lookup, a search costs three requests.
 *
 * Fails with a `PluginError` for a `scopeRef`, because Sentry has no context
 * a search can be narrowed to, and widening the search would give results
 * outside the scope the user asked for. Otherwise fails as `callSentry` does.
 */
export const searchIssues = (
  access: OrganizationAccess,
  accountId: string,
  query: { readonly text: string; readonly scopeRef?: string; readonly limit: number },
): Effect.Effect<ReadonlyArray<EntityObservation>, SentryFailure, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    if (query.scopeRef !== undefined) {
      return yield* new PluginError({
        message: `Sentry cannot search inside ${query.scopeRef}: it can search only the whole organization.`,
      });
    }
    const path = `/api/0/organizations/${access.organization.slug}/issues/`;
    const response = yield* callSentry({
      method: "GET",
      baseUrl: access.organization.regionUrl,
      path,
      token: access.token,
      query: [
        ["query", query.text],
        ["shortIdLookup", "1"],
        ["limit", String(Math.min(query.limit, MAX_SEARCH_LIMIT))],
        ["groupStatsPeriod", ""],
      ],
    });
    const issues = yield* decodeSentryBody(Schema.Array(ApiIssue), response.body, path);
    const context = yield* readObservationContext(access, accountId);
    return issues
      .slice(0, query.limit)
      .flatMap((issue) => buildIssueObservation(issue, context, []) ?? []);
  });

/** What the short id endpoint answers: the issue, under `group`. */
const ShortIdAnswer = Schema.Struct({ group: ApiIssue });

/**
 * Reads the issue a short id names in this organization. Returns undefined
 * when Sentry answers 404, which it does for an unknown short id and for an
 * issue being deleted. Costs one request.
 */
const readIssueByShortId = (
  access: OrganizationAccess,
  shortId: string,
): Effect.Effect<ApiIssue | undefined, SentryFailure, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const path = `/api/0/organizations/${access.organization.slug}/shortids/${encodeURIComponent(shortId)}/`;
    const response = yield* callSentry(
      { method: "GET", baseUrl: access.organization.regionUrl, path, token: access.token },
      [404],
    );
    if (response.status === 404) return undefined;
    return (yield* decodeSentryBody(ShortIdAnswer, response.body, path)).group;
  });

/**
 * Reads the issue with the id `issueId` and returns what the core stores for
 * it, or `missing: "not-found"` when Sentry returns no such issue or the issue
 * is being deleted, merged or reprocessed. Sentry answers the same for an
 * issue that never existed and one that was deleted, and the token reaches the
 * whole organization, so the answer is `not-found` and never `inaccessible`.
 * Costs two requests: the issue and the teams.
 */
const resolveIssueById = (
  access: OrganizationAccess,
  accountId: string,
  issueId: string,
): Effect.Effect<EntityResolution, SentryFailure, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const issue = (yield* lookUpIssues(access, [issueId])).get(issueId);
    return yield* buildResolution(access, accountId, issue);
  });

/** Turns an issue Sentry returned, or none, into the resolution of a lookup. */
const buildResolution = (
  access: OrganizationAccess,
  accountId: string,
  issue: ApiIssue | undefined,
): Effect.Effect<EntityResolution, SentryFailure, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    if (issue === undefined) return { missing: "not-found" as const };
    const found = buildIssueObservation(
      issue,
      yield* readObservationContext(access, accountId),
      [],
    );
    return found === undefined ? { missing: "not-found" as const } : { found };
  });

/**
 * Reads the issue a recognition names. Returns:
 *
 * - `outOfScope` when the recognition's `scopeHint` is not this organization's
 *   slug (compared without case), before any issue is read;
 * - `missing: "inaccessible"` for a ref of another organization;
 * - `missing: "not-found"` when Sentry returns no issue, or one that is being
 *   deleted, merged or reprocessed.
 *
 * Costs two requests for an id or a ref (the issue, the teams) and the same
 * for a short id, beside the organization lookup. Fails with a `PluginError`
 * for a ref that is not an issue's and an identifier that is not a short id.
 */
export const resolveIssue = (
  access: OrganizationAccess,
  accountId: string,
  target: EntityRecognition,
): Effect.Effect<EntityResolution, SentryFailure, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    if (target.recognized === "ref") {
      const parsed = parseIssueRef(target.ref);
      if (parsed === undefined) {
        return yield* new PluginError({
          message: `Sentry reads issues, and ${target.ref} is not an issue's ref.`,
        });
      }
      if (parsed.organizationId !== access.organization.id) {
        return { missing: "inaccessible" as const };
      }
      return yield* resolveIssueById(access, accountId, parsed.issueId);
    }
    if (target.form === "url") {
      if (
        target.scopeHint !== undefined &&
        target.scopeHint.toLowerCase() !== access.organization.slug.toLowerCase()
      ) {
        return { outOfScope: true as const };
      }
      return yield* resolveIssueById(access, accountId, target.identifier);
    }
    if (!SHORT_ID.test(target.identifier)) {
      return yield* new PluginError({
        message: `Sentry reads an issue written like STOREFRONT-21C, and ${target.identifier} is not.`,
      });
    }
    return yield* buildResolution(
      access,
      accountId,
      yield* readIssueByShortId(access, target.identifier),
    );
  });

export const sentryEntityLookup: EntityLookup = {
  recognize: recognizeSentryIssues,
  search: (connection, context, query) =>
    withOrganizationAccess(context, (access) => searchIssues(access, connection.accountId, query)),
  resolve: (connection, context, target) =>
    withOrganizationAccess(context, (access) => resolveIssue(access, connection.accountId, target)),
  readBlocks: (_connection, context, ref) =>
    withOrganizationAccess(context, (access) => readIssueBlocks(access, ref)),
};
