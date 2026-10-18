/**
 * The skills a session has, or a new Thread would have: the library part from
 * the Skill Library and the repository part from the runner.
 *
 * The repository part is read live from the runner, so this use case lives in
 * the controller daemon, which is the only place that sends frames to
 * runners. A repository part that cannot be read never fails the request: the
 * library part is still returned, with the reason in plain words.
 */
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import { REPOSITORY_SKILLS_CAPABILITY, type RepositorySkill } from "@hercule/protocol";
import {
  createNotFoundError,
  type Forbidden,
  type NotFound,
  type RunnerDetail,
  type SessionSkill,
  type SessionSkillFilter,
  type SessionSkillList,
} from "@hercule/contract";
import { requireGrant } from "../../actor";
import { mintUuid, uuidToString } from "../../db";
import { resourceRepository, type StoredResource } from "../../resources";
import { NO_SUCH_RUNNER, RunnerConnections, runnerRepository } from "../../runners";
import { readSessionOrFail, sessionRepository } from "../../sessions";
import { decideSessionSkills } from "../../skills";
import { WorkspaceService } from "../../workspaces";

/** How long to wait for a runner to list the skills of a workspace. */
const LISTING_DEADLINE = Duration.seconds(10);

const NO_SUCH_RESOURCE = "no such resource";

/** What reading the repository skills of one workspace came to. */
type Listing =
  | { readonly _tag: "listed"; readonly skills: ReadonlyArray<RepositorySkill> }
  | { readonly _tag: "unavailable"; readonly reason: string };

const unavailable = (reason: string): Listing => ({ _tag: "unavailable", reason });

const compareByName = (a: { readonly name: string }, b: { readonly name: string }): number =>
  a.name < b.name ? -1 : a.name > b.name ? 1 : 0;

/** Returns what a user calls this resource: its label, else its remote. */
const describeResource = (resource: StoredResource): string =>
  resource.label ?? resource.canonicalRemote ?? resource.id;

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const sessions = yield* sessionRepository;
  const resources = yield* resourceRepository;
  const runners = yield* runnerRepository;
  const workspaces = yield* WorkspaceService;
  const connections = yield* RunnerConnections;
  const readSession = readSessionOrFail(sessions);
  const withSql = Effect.provideService(SqlClient.SqlClient, sql);

  const readRunner = (id: string): Effect.Effect<RunnerDetail, NotFound | SqlError> =>
    Effect.flatMap(
      runners.read(id),
      Option.match({
        onNone: () => Effect.fail(createNotFoundError(NO_SUCH_RUNNER)),
        onSome: Effect.succeed,
      }),
    );

  /**
   * Asks the runner for the repository skills of one workspace. Never fails:
   * a runner that cannot answer gives an `unavailable` listing whose reason
   * tells the user what to do.
   */
  const listRepositorySkills = (
    runner: RunnerDetail,
    workspaceId: string,
  ): Effect.Effect<Listing> =>
    Effect.gen(function* () {
      if (!(runner.negotiatedCapabilities ?? []).includes(REPOSITORY_SKILLS_CAPABILITY))
        return unavailable(
          `The runner \`${runner.name}\` is too old to list repository skills. Update it to see them.`,
        );
      const answer = yield* connections.asked(
        runner.id,
        { _tag: "repositorySkillsInspect", requestId: uuidToString(mintUuid()), workspaceId },
        LISTING_DEADLINE,
      );
      if (
        Option.isNone(answer) ||
        answer.value._tag !== "repositorySkillsInspection" ||
        answer.value.workspaceId !== workspaceId
      )
        return unavailable(
          `The runner \`${runner.name}\` is offline or did not answer in time, so repository skills cannot be listed. Check that it is online and try again.`,
        );
      const { outcome } = answer.value;
      return outcome.status === "listed"
        ? { _tag: "listed", skills: outcome.skills }
        : unavailable(
            `The runner \`${runner.name}\` could not list repository skills: ${outcome.message}`,
          );
    });

  /** Reads the repository skills of a repo's main workspace on the runner. */
  const listRepositorySkillsOfRepo = (
    runner: RunnerDetail,
    resource: StoredResource,
  ): Effect.Effect<Listing, SqlError> =>
    Effect.gen(function* () {
      const workspaceId = yield* workspaces.readReadyPrimaryId(resource.id, runner.id);
      return Option.isNone(workspaceId)
        ? unavailable(
            `The repo \`${describeResource(resource)}\` has no ready main workspace on the runner \`${runner.name}\`, so its repository skills cannot be listed. Provision the workspace to see them.`,
          )
        : yield* listRepositorySkills(runner, workspaceId.value);
    });

  /**
   * Builds the list: the library skills first, then the repository skills,
   * each part sorted by name. The first listing that is unavailable gives the
   * reason; the skills of the other listings are kept.
   */
  const buildList = (
    library: ReadonlyArray<{ readonly name: string; readonly description: string }>,
    listings: ReadonlyArray<Listing>,
  ): SessionSkillList => {
    const libraryItems = library
      .map((skill): SessionSkill => ({ source: "library", ...skill }))
      .sort(compareByName);
    const repositoryItems = listings
      .flatMap((listing) => (listing._tag === "listed" ? listing.skills : []))
      .map((skill): SessionSkill => ({
        source: "repository",
        name: `${skill.checkoutName}:${skill.name}`,
        description: skill.description,
        path: skill.path,
      }))
      .sort(compareByName);
    const missing = listings.find((listing) => listing._tag === "unavailable");
    return {
      items: [...libraryItems, ...repositoryItems],
      ...(missing === undefined ? {} : { repositorySkillsUnavailable: missing.reason }),
    };
  };

  /** The skills of a session: what it got at its last claimed start, and its workspace's checkouts. */
  const listForSession = (id: string) =>
    Effect.gen(function* () {
      const session = yield* readSession(id);
      const recorded = yield* sessions.readLibrarySkills(id);
      // A session whose start was never claimed gets, at its start, the
      // library as it is then.
      const library = Option.isSome(recorded)
        ? recorded.value
        : yield* withSql(decideSessionSkills({ agentId: session.agentId }));
      if (session.workspaceId === null) return buildList(library, []);
      const runner = yield* readRunner(session.runnerId);
      return buildList(library, [yield* listRepositorySkills(runner, session.workspaceId)]);
    });

  /** The skills a new Thread with these repos on this runner would get. */
  const listForDraft = (runnerId: string, resourceIds: ReadonlyArray<string>) =>
    Effect.gen(function* () {
      const runner = yield* readRunner(runnerId);
      const distinctIds = [...new Set(resourceIds)];
      const found = yield* resources.byIds(distinctIds);
      const repos: Array<StoredResource> = [];
      for (const resourceId of distinctIds) {
        const resource = found.get(resourceId);
        if (resource === undefined)
          return yield* Effect.fail(createNotFoundError(NO_SUCH_RESOURCE));
        repos.push(resource);
      }
      const library = yield* withSql(decideSessionSkills({ agentId: null }));
      const listings = yield* Effect.forEach(
        repos,
        (resource) => listRepositorySkillsOfRepo(runner, resource),
        { concurrency: "unbounded" },
      );
      return buildList(library, listings);
    });

  return {
    /**
     * Returns the skills of a session, or the skills a new Thread would get
     * for a draft, as `SessionSkillFilter` says. The library part is listed
     * even when the repository part cannot be read; the list then holds
     * `repositorySkillsUnavailable`, which says why.
     *
     * Fails with `Forbidden` when the caller lacks the grant, and with
     * `NotFound` when no session, runner or resource has an id given.
     */
    query: (
      filter: SessionSkillFilter,
    ): Effect.Effect<SessionSkillList, Forbidden | NotFound | SqlError> =>
      Effect.gen(function* () {
        yield* requireGrant("sessionSkill.query");
        if (filter.sessionId !== undefined) return yield* listForSession(filter.sessionId);
        if (filter.runnerId !== undefined && filter.resourceId !== undefined)
          return yield* listForDraft(filter.runnerId, filter.resourceId);
        // The contract admits only the two forms above.
        return yield* Effect.die("sessionSkill.query reached with neither form of the filter");
      }),
  };
});

export class SessionSkills extends Context.Service<SessionSkills, Effect.Success<typeof make>>()(
  "hercule/controller/daemon/SessionSkills",
) {}

export const SessionSkillsLayer: Layer.Layer<
  SessionSkills,
  never,
  SqlClient.SqlClient | WorkspaceService | RunnerConnections
> = Layer.effect(SessionSkills)(make);
