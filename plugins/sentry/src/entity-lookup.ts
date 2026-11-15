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
  type AuthError,
  PluginError,
  type EntityLookup,
  type EntityLookupContext,
  type EntityObservation,
  type EntityRecognition,
  type EntityResolution,
} from "@hercule/plugin-host";
import { callSentry, decodeSentryBody, type SentryFailure } from "./api";
import { readIssueBlocks } from "./entity-blocks";
import { ISSUE_KIND } from "./entity-kinds";
import {
  buildIssueObservation,
  isDeletedInSentry,
  readIssueObservationContext,
} from "./entity-reads";
import { readUserId } from "./identity";
import { issuesPath, LIST_PARAMETERS, lookUpIssues, PAGE_SIZE } from "./ingest/list";
import {
  openOrganizationAccess,
  readOrganizationResource,
  type OrganizationAccess,
} from "./organization";
import { parseIssueRef } from "./refs";
import { ApiIssue, ApiShortIdAnswer } from "./sentry-objects";

/** The most things `recognize` returns for one text. */
const MAX_RECOGNITIONS = 20;

/** An organization's slug, as it appears in an address. */
const ORGANIZATION_SLUG_SOURCE = "[A-Za-z0-9][A-Za-z0-9-]{0,49}";

/** The most digits of an issue id: the bound the plugin puts on every id. */
const MAX_ISSUE_ID_DIGITS = 32;

/**
 * Builds the pattern source of a short id such as `STOREFRONT-21C`: a project
 * slug, a dash, and a suffix. `letters` is the letters allowed, so the caller
 * chooses capitals only or both cases.
 *
 * - The slug is Sentry's project slug (letters, digits, `_` and `-`, starting
 *   with a letter or digit, at most 100 characters) written in capitals.
 * - The suffix is Sentry's base32 alphabet, `0123456789ABCDEFGHJKMNPQRSTVWXYZ`
 *   (no I, L, O or U), at most 13 characters: the most a 64-bit counter needs.
 * - A slug may hold dashes, so a dash cannot tell where the suffix starts. The
 *   last dash splits them, because the greedy slug backtracks to it.
 *
 * Every repetition is bounded, so a long run of dashes cannot make a match slow.
 */
const buildShortIdSource = (letters: "capitals" | "any-case"): string => {
  const lower = letters === "capitals" ? "" : "a-z";
  const lowerSuffix = letters === "capitals" ? "" : "a-hjkmnp-tv-z";
  return `[A-Z0-9${lower}][A-Z0-9${lower}_-]{0,99}-[0-9A-HJKMNP-TV-Z${lowerSuffix}]{1,13}`;
};

/**
 * Returns true when `text` is a short id in any case. A slug of only digits
 * and dashes is not a short id: Sentry slugs are not made of digits alone, and
 * it keeps a date such as `2024-01-15` out.
 */
const isShortId = (text: string): boolean =>
  new RegExp(`^${buildShortIdSource("any-case")}$`).test(text) &&
  /[A-Za-z]/.test(text.slice(0, text.lastIndexOf("-")));

/** What follows an address's issue segment: a real boundary, never more of a word. */
const ADDRESS_END = "(?=[/?#\\s)\\]}>,.;:!\"'*]|$)";

/** The issue segment of an address: the numeric id, or a short id in place of it. */
const ISSUE_SEGMENT = `(\\d{1,${String(MAX_ISSUE_ID_DIGITS)}}|${buildShortIdSource("any-case")})`;

/**
 * Matches, in order, the three ways a text names one issue: the address
 * `https://<org>.sentry.io/issues/<id or short id>/`, the address
 * `https://sentry.io/organizations/<org>/issues/<id or short id>/`, and a
 * short id in capitals. The short id may not start inside a longer word or
 * path, so nothing inside an address is read twice. The address must end its
 * host at `sentry.io`, so `sentry.io.evil.com` and `evil.com/sentry.io/...`
 * match nothing, and its issue segment must end at a boundary, so
 * `/issues/123oops/` matches nothing.
 *
 * Words such as `UTF-8` or `SHA-256` are short ids by shape, so they match
 * too. That only costs a failed read when the user adds one, which the spec
 * accepts (spec 20 section 5.4).
 */
const MENTION = new RegExp(
  `https://(${ORGANIZATION_SLUG_SOURCE})\\.sentry\\.io/issues/${ISSUE_SEGMENT}${ADDRESS_END}` +
    `|https://sentry\\.io/organizations/(${ORGANIZATION_SLUG_SOURCE})/issues/${ISSUE_SEGMENT}${ADDRESS_END}` +
    `|(?<![\\w/.-])(${buildShortIdSource("capitals")})(?![\\w-])`,
  "g",
);

/**
 * Returns the issues `text` names, in order, each once, at most 20. An address
 * gives a scoped recognition whose `identifier` is the issue's id (or its
 * short id, when the address holds one) and whose `scopeHint` is the
 * organization's slug. A short id in the text gives a scoped recognition with
 * no hint. A Linear key such as `SHOP-123` reads as a short id too: each
 * plugin recognizes its own shapes, and the core shows only the ones that
 * resolve. Reads no page and needs no credentials.
 */
export const recognizeSentryIssues = (text: string): ReadonlyArray<EntityRecognition> => {
  const recognitions: Array<EntityRecognition> = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(MENTION)) {
    if (recognitions.length === MAX_RECOGNITIONS) break;
    const [, subdomainSlug, subdomainIssue, pathSlug, pathIssue, textShortId] = match;
    const organizationSlug = subdomainSlug ?? pathSlug;
    const identifier = subdomainIssue ?? pathIssue ?? textShortId ?? "";
    if (!/^\d+$/.test(identifier) && !isShortId(identifier)) continue;
    const key = `${organizationSlug?.toLowerCase() ?? ""}/${identifier.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    recognitions.push(
      organizationSlug === undefined
        ? { recognized: "scoped", form: "identifier", kind: ISSUE_KIND, identifier }
        : {
            recognized: "scoped",
            form: "url",
            kind: ISSUE_KIND,
            identifier,
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
    Effect.flatMap((credentials) => openOrganizationAccess(credentials).pipe(Effect.flatMap(use))),
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
 * Searches the organization's issues by words or a short id, at most `limit`,
 * whatever their status. Sends one issues-list request with `shortIdLookup=1`,
 * so a short id in the text comes back alone. Reads the organization's teams
 * only when the search found something, after the issues: with the
 * organization lookup a search costs three requests, and two when it finds
 * nothing.
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
    const response = yield* callSentry({
      method: "GET",
      baseUrl: access.organization.regionUrl,
      path: issuesPath(access),
      token: access.token,
      query: [
        ["query", query.text],
        ["shortIdLookup", "1"],
        ["limit", String(Math.min(query.limit, PAGE_SIZE))],
        ...LIST_PARAMETERS.filter(([name]) => name !== "limit"),
      ],
    });
    const issues = yield* decodeSentryBody(
      Schema.Array(ApiIssue),
      response.body,
      issuesPath(access),
    );
    if (issues.length === 0) return [];
    const context = yield* readIssueObservationContext(access, readUserId(accountId));
    return issues.flatMap((issue) => buildIssueObservation(issue, context, []) ?? []);
  });

/**
 * Reads the issue a short id names in this organization. Returns undefined
 * when Sentry answers 404, which it does for an unknown short id, for an issue
 * being deleted, and for an issue of a project the token cannot see. Costs
 * one request.
 */
const readIssueByShortId = (
  access: OrganizationAccess,
  shortId: string,
): Effect.Effect<ApiIssue | undefined, SentryFailure, HttpClient.HttpClient> =>
  Effect.map(
    readOrganizationResource(
      access,
      `/api/0/organizations/${access.organization.slug}/shortids/${encodeURIComponent(shortId)}/`,
      ApiShortIdAnswer,
    ),
    (answer) => answer?.group,
  );

/**
 * Reads the issue with `readIssue` and the organization's teams at the same
 * time, and returns what the core stores for the issue. Returns:
 *
 * - `missing: "unknown"` when Sentry returns no issue, or one that is being
 *   merged away or reprocessed. Sentry hides the issues of projects the token
 *   cannot see, so it cannot tell a missing issue from a forbidden one;
 * - `missing: "not-found"` when the issue's status says it is being deleted
 *   or merged, the one explicit evidence that it is gone;
 * - `found` otherwise.
 *
 * Reading both at once keeps a lookup inside the core's time limit. The teams
 * are read even when the issue turns out to be missing.
 */
const resolveWith = (
  access: OrganizationAccess,
  accountId: string,
  readIssue: Effect.Effect<ApiIssue | undefined, SentryFailure, HttpClient.HttpClient>,
): Effect.Effect<EntityResolution, SentryFailure, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const [issue, context] = yield* Effect.all(
      [readIssue, readIssueObservationContext(access, readUserId(accountId))],
      { concurrency: 2 },
    );
    if (issue === undefined) return { missing: "unknown" as const };
    if (isDeletedInSentry(issue)) return { missing: "not-found" as const };
    const found = buildIssueObservation(issue, context, []);
    return found === undefined ? { missing: "unknown" as const } : { found };
  });

/**
 * Reads the issue a recognition names. Returns:
 *
 * - `outOfScope` when the recognition's `scopeHint` is not this organization's
 *   slug (compared without case), before any issue is read;
 * - `missing: "inaccessible"` for a ref of another organization;
 * - `missing: "unknown"` when Sentry returns no issue, or one that is being
 *   reprocessed;
 * - `missing: "not-found"` when the issue is being deleted or merged away.
 *
 * Costs two requests, made at the same time (the issue and the teams), beside
 * the organization lookup. Fails with a `PluginError` for a ref that is not an
 * issue's and an identifier that is neither an issue id nor a short id.
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
      return yield* resolveWith(
        access,
        accountId,
        Effect.map(lookUpIssues(access, [parsed.issueId]), (found) => found.get(parsed.issueId)),
      );
    }
    if (
      target.form === "url" &&
      target.scopeHint !== undefined &&
      target.scopeHint.toLowerCase() !== access.organization.slug.toLowerCase()
    ) {
      return { outOfScope: true as const };
    }
    if (target.form === "url" && /^\d+$/.test(target.identifier)) {
      return yield* resolveWith(
        access,
        accountId,
        Effect.map(lookUpIssues(access, [target.identifier]), (found) =>
          found.get(target.identifier),
        ),
      );
    }
    if (!isShortId(target.identifier)) {
      return yield* new PluginError({
        message: `Sentry reads an issue written as an id or like STOREFRONT-21C, and ${target.identifier} is neither.`,
      });
    }
    return yield* resolveWith(access, accountId, readIssueByShortId(access, target.identifier));
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
