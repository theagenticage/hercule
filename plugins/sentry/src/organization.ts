/**
 * The Sentry organization a Connection watches, and how to read its lists.
 * Nothing about the organization is stored in the Connection's config: every
 * caller finds it from the credentials, so a renamed organization keeps
 * working.
 */
import { Effect, type Schema } from "effect";
import type * as HttpClient from "effect/unstable/http/HttpClient";
import { PluginError } from "@hercule/plugin-host";
import {
  callSentry,
  decodeSentryBody,
  readPages,
  SENTRY_API_URL,
  type PagedItems,
  type SentryFailure,
} from "./api";
import { ApiMember, ApiOrganization } from "./sentry-objects";

/** The organization a Connection watches. */
export interface SentryOrganization {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  /** The host that serves the organization's data, such as `https://us.sentry.io`. */
  readonly regionUrl: string;
}

/** What a call about an organization needs: its token and the organization. */
export interface OrganizationAccess {
  readonly token: string;
  readonly organization: SentryOrganization;
}

/** The most pages a list of the organization is read in. A page holds up to 100 items. */
export const MAX_LIST_PAGES = 10;

/**
 * Reads every page of a list of the organization, such as its teams, up to
 * `MAX_LIST_PAGES`. `subpath` is the list below the organization, such as
 * `/teams/`. Fails as `readPages` does.
 */
export const readOrganizationList = <S extends Schema.Decoder<unknown>>(
  access: OrganizationAccess,
  subpath: string,
  item: S,
  query: ReadonlyArray<readonly [string, string]> = [],
): Effect.Effect<PagedItems<S["Type"]>, SentryFailure, HttpClient.HttpClient> =>
  readPages(
    {
      method: "GET",
      baseUrl: access.organization.regionUrl,
      path: `/api/0/organizations/${access.organization.slug}${subpath}`,
      token: access.token,
      query,
    },
    item,
    MAX_LIST_PAGES,
  );

/**
 * Finds the organization the credentials reach. The pasted token comes with
 * the organization's slug in `organization`, and the one organization with
 * that slug is used. A device-flow token has no slug, and Sentry limits it to
 * the one organization the user picked, so the only organization it lists is
 * used.
 *
 * Fails with a `PluginError` saying what to do when the token reaches no
 * organization, reaches several and names none, or does not reach the one
 * named. Fails as `readPages` does for anything Sentry answers.
 */
export const findOrganization = (
  token: string,
  credentials: Readonly<Record<string, string>>,
): Effect.Effect<SentryOrganization, SentryFailure, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const organizations = yield* Effect.map(
      readPages(
        { method: "GET", baseUrl: SENTRY_API_URL, path: "/api/0/organizations/", token },
        ApiOrganization,
        MAX_LIST_PAGES,
      ),
      (listed) => listed.items,
    );
    const wanted = credentials["organization"]?.trim().toLowerCase();
    if (wanted !== undefined && wanted !== "") {
      const found = organizations.find((candidate) => candidate.slug.toLowerCase() === wanted);
      if (found === undefined) {
        return yield* new PluginError({
          message: `The token does not reach an organization with the slug "${wanted}". Check the slug, and that the token belongs to that organization.`,
        });
      }
      return { id: found.id, slug: found.slug, name: found.name, regionUrl: found.links.regionUrl };
    }
    const [only, ...others] = organizations;
    if (only === undefined) {
      return yield* new PluginError({
        message: "The token does not reach any Sentry organization.",
      });
    }
    if (others.length > 0) {
      return yield* new PluginError({
        message:
          "The token reaches more than one Sentry organization. Paste an auth token of the organization you want, with its slug.",
      });
    }
    return { id: only.id, slug: only.slug, name: only.name, regionUrl: only.links.regionUrl };
  });

/** Reads the Sentry account of the token's user in the organization: its user id and username. */
export const readCurrentUser = (
  access: OrganizationAccess,
): Effect.Effect<
  { readonly id: string; readonly username: string },
  SentryFailure,
  HttpClient.HttpClient
> =>
  Effect.gen(function* () {
    const response = yield* callSentry({
      method: "GET",
      baseUrl: access.organization.regionUrl,
      path: `/api/0/organizations/${access.organization.slug}/members/me/`,
      token: access.token,
    });
    const member = yield* decodeSentryBody(ApiMember, response.body, "/members/me/");
    const user = member.user;
    if (user === undefined || user === null) {
      return yield* new PluginError({
        message: "Sentry's answer about the token's member did not name the member's user.",
      });
    }
    return { id: user.id, username: user.username };
  });
