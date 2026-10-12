/**
 * Turns a Connection's config into what the issue list is asked for. The
 * config holds ids, so a rename in Sentry changes nothing; each poll reads the
 * lists it needs and turns the ids into the slugs and usernames Sentry's
 * search takes.
 */
import { Effect } from "effect";
import type * as HttpClient from "effect/unstable/http/HttpClient";
import { PluginError } from "@hercule/plugin-host";
import type { SentryFailure } from "../api";
import type { SentryConnectionConfig } from "../connection-type";
import { DEFAULT_LAST_SEEN_DAYS } from "../connection-type";
import { readOrganizationList, type OrganizationAccess } from "../organization";
import { ApiEnvironment, ApiMember, ApiProject, ApiTeam } from "../sentry-objects";

/** The user's own issue list: what an empty `assignees` means. */
const DEFAULT_ASSIGNEES: ReadonlyArray<string> = ["me", "my_teams"];

/** The assignee values that need no lookup, because Sentry's search knows them by name. */
const FIXED_ASSIGNEES: ReadonlySet<string> = new Set(["me", "my_teams", "none"]);

/** What the issue list is asked for. */
export interface ResolvedFilter {
  /** Sentry search syntax, such as `is:unresolved lastSeen:-14d assigned:[me, my_teams]`. */
  readonly query: string;
  /** The ids of the projects to list, sorted. Empty means every project the user can see. */
  readonly projectIds: ReadonlyArray<string>;
  /** The environments to list, sorted. Empty means every environment. */
  readonly environments: ReadonlyArray<string>;
  readonly lastSeenDays: number;
  /**
   * A string that is the same for the same filter. When it differs from the
   * one stored, the filter changed, and the set the poll lists is not
   * comparable with the stored one. It is built from ids and settings only,
   * never from team slugs or usernames, so renaming a team or a user in
   * Sentry does not change it.
   */
  readonly fingerprint: string;
}

/**
 * Fails with a `PluginError` for a configured value Sentry no longer has.
 * The poll diffs nothing then: a filter that matches nothing would make every
 * issue look as if it had left, and end all their signals.
 */
const failMissing = (what: string): PluginError =>
  new PluginError({
    message: `${what} is in the Connection's settings but Sentry no longer has it. Remove it in the Connection's settings.`,
  });

/**
 * Quotes a search value that has a character Sentry's search would read as
 * syntax. A username is often an email address, which needs none.
 */
const quoteSearchValue = (value: string): string =>
  /[\s,[\]"]/.test(value) ? `"${value.replaceAll('"', '\\"')}"` : value;

/** Sorts text the same way on every machine, whatever the locale. */
const sortText = (values: Iterable<string>): Array<string> =>
  [...new Set(values)].sort((first, second) => (first < second ? -1 : first > second ? 1 : 0));

/**
 * Returns the assignees the config asks for, sorted: the configured values,
 * the default pair when none is configured, and just `anyone` when `anyone`
 * is among them, because it overrides the rest.
 */
const listWantedAssignees = (configured: ReadonlyArray<string> | undefined): Array<string> => {
  const wanted =
    configured === undefined || configured.length === 0 ? DEFAULT_ASSIGNEES : configured;
  return wanted.includes("anyone") ? ["anyone"] : sortText(wanted);
};

/**
 * Returns the `assigned:` values for the wanted assignees, or undefined for no
 * `assigned:` filter at all (`anyone`). Reads the teams and the members only
 * when a team or a user is wanted.
 */
const resolveAssignees = (
  access: OrganizationAccess,
  wanted: ReadonlyArray<string>,
): Effect.Effect<ReadonlyArray<string> | undefined, SentryFailure, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    if (wanted.includes("anyone")) return undefined;
    const teams = wanted.some((value) => value.startsWith("team:"))
      ? yield* readOrganizationList(access, "/teams/", ApiTeam)
      : [];
    const members = wanted.some((value) => value.startsWith("user:"))
      ? yield* readOrganizationList(access, "/members/", ApiMember)
      : [];
    const values: Array<string> = [];
    for (const value of wanted) {
      if (FIXED_ASSIGNEES.has(value)) {
        values.push(value);
      } else if (value.startsWith("team:")) {
        const team = teams.find((candidate) => `team:${candidate.id}` === value);
        if (team === undefined) return yield* failMissing(`The team ${value}`);
        values.push(`#${team.slug}`);
      } else if (value.startsWith("user:")) {
        const member = members.find((candidate) => `user:${candidate.user?.id ?? ""}` === value);
        if (member?.user == null) return yield* failMissing(`The member ${value}`);
        values.push(quoteSearchValue(member.user.username));
      } else {
        return yield* failMissing(`The assignee "${value}"`);
      }
    }
    return sortText(values);
  });

/**
 * Returns the ids of the projects to list. `project:<id>` is one project and
 * `team:<id>` is every project of that team, as the team owns them now. A
 * team with no projects fails the poll, because an empty project list would
 * mean every project.
 */
const resolveProjects = (
  access: OrganizationAccess,
  configured: ReadonlyArray<string> | undefined,
): Effect.Effect<ReadonlyArray<string>, SentryFailure, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    if (configured === undefined || configured.length === 0) return [];
    const projects = yield* readOrganizationList(access, "/projects/", ApiProject);
    const ids = new Set<string>();
    for (const value of configured) {
      if (value.startsWith("project:")) {
        const project = projects.find((candidate) => `project:${candidate.id}` === value);
        if (project === undefined) return yield* failMissing(`The project ${value}`);
        ids.add(project.id);
      } else if (value.startsWith("team:")) {
        const owned = projects.filter((candidate) =>
          (candidate.teams ?? []).some((team) => `team:${team.id}` === value),
        );
        if (owned.length === 0) {
          return yield* new PluginError({
            message: `The team ${value} owns no projects; an empty project list would watch every project. Remove it in the Connection's settings, or add a project to the team in Sentry.`,
          });
        }
        for (const project of owned) ids.add(project.id);
      } else {
        return yield* failMissing(`The project "${value}"`);
      }
    }
    return sortText(ids);
  });

/** Checks that every configured environment exists, and returns them sorted. */
const resolveEnvironments = (
  access: OrganizationAccess,
  configured: ReadonlyArray<string> | undefined,
): Effect.Effect<ReadonlyArray<string>, SentryFailure, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    if (configured === undefined || configured.length === 0) return [];
    const environments = yield* readOrganizationList(access, "/environments/", ApiEnvironment);
    for (const name of configured) {
      if (!environments.some((candidate) => candidate.name === name)) {
        return yield* failMissing(`The environment "${name}"`);
      }
    }
    return sortText(configured);
  });

/**
 * Resolves the config into the filter the issue list is asked for. Fails with
 * a `PluginError` naming the first configured team, user, project or
 * environment that Sentry no longer has, and fails as `readPages` does for
 * anything Sentry answers.
 */
export const resolveFilter = (
  access: OrganizationAccess,
  config: SentryConnectionConfig,
): Effect.Effect<ResolvedFilter, SentryFailure, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const lastSeenDays = config.lastSeenDays ?? DEFAULT_LAST_SEEN_DAYS;
    const wantedAssignees = listWantedAssignees(config.assignees);
    const assignees = yield* resolveAssignees(access, wantedAssignees);
    const projectIds = yield* resolveProjects(access, config.projects);
    const environments = yield* resolveEnvironments(access, config.environments);
    const query = [
      "is:unresolved",
      `lastSeen:-${String(lastSeenDays)}d`,
      ...(assignees === undefined ? [] : [`assigned:[${assignees.join(", ")}]`]),
    ].join(" ");
    return {
      query,
      projectIds,
      environments,
      lastSeenDays,
      fingerprint: JSON.stringify({
        assignees: wantedAssignees,
        lastSeenDays,
        projects: projectIds,
        environments,
      }),
    };
  });
