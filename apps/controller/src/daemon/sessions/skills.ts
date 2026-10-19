/**
 * The skills a session has, or a new Thread would have: the library part from
 * the Skill Library and the repository part from the runner.
 *
 * The repository part is read live from the runner, so these use cases live in
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
import {
  describeDuplicateCheckoutName,
  extractRepoName,
  formatCheckoutName,
  REPOSITORY_SKILLS_CAPABILITY,
  type RepositorySkill,
  type SkippedRepositorySkill,
} from "@hercule/protocol";
import {
  createNotFoundError,
  type Forbidden,
  type NotFound,
  type RunnerDetail,
  type SessionSkill,
  type SessionSkillList,
  type SkillsPreviewFilter,
  type Validation,
} from "@hercule/contract";
import { requireGrant } from "../../actor";
import { mintUuid, uuidToString } from "../../db";
import { NO_SUCH_RESOURCE, resourceRepository, type StoredRepo } from "../../resources";
import { readRunnerOrFail, RunnerConnections, runnerRepository } from "../../runners";
import { readSessionOrFail, sessionRepository, type StoredSession } from "../../sessions";
import { decideSessionSkills, type SessionLibrarySkill } from "../../skills";
import { requireCheckedOut, validateCheckoutDirectories, WorkspaceService } from "../../workspaces";

/** How long to wait for a runner to list the skills of a workspace. */
const LISTING_DEADLINE = Duration.seconds(10);

/**
 * How many workspaces one preview inspects at the same time. A preview names up
 * to 32 repos, often on one runner, and each inspection walks the skill folders
 * of a workspace on that runner's disk.
 */
const PREVIEW_CONCURRENCY = 4;

/** What reading the repository skills of one workspace came to. */
type RepositorySkillsListing =
  | {
      readonly _tag: "listed";
      readonly skills: ReadonlyArray<RepositorySkill>;
      readonly skipped: ReadonlyArray<SkippedRepositorySkill>;
    }
  | { readonly _tag: "unavailable"; readonly reason: string };

/** The part of the answer for a session that started before its library skills were recorded. */
const LIBRARY_NOT_RECORDED =
  "This session started before the controller recorded its library skills, so they are not listed. They are listed after the session is resumed.";

const buildUnavailableListing = (reason: string): RepositorySkillsListing => ({
  _tag: "unavailable",
  reason,
});

const compareByName = (a: { readonly name: string }, b: { readonly name: string }): number =>
  a.name < b.name ? -1 : a.name > b.name ? 1 : 0;

/** Returns what a user calls this repo: its label, else its remote. */
const describeRepo = (repo: StoredRepo): string => repo.label ?? repo.canonicalRemote;

/**
 * Checks whether the controller ever claimed a start of this session, so that
 * a library skills record that is missing means "recorded before this
 * feature", not "not recorded yet".
 *
 * - `queued`: the start is still to come, even for a session resumed after a
 *   run. The next claim records the library then.
 * - `starting`, `idle` and `busy`: a start was claimed.
 * - `exited`: a start was claimed when the process ever became ready
 *   (`startedAt`). A session that exited from the queue, or whose start
 *   failed before the process was ready, holds no skills either way, and is
 *   counted as never started.
 */
const hasClaimedStart = (session: StoredSession): boolean =>
  session.status !== "queued" && (session.status !== "exited" || session.startedAt !== null);

/**
 * Builds the answer: the library skills first, then the repository skills,
 * each part sorted by name. `skipped` holds the skipped folders of every
 * listing. `incompleteReason` joins, in one message, `libraryNote` and the
 * distinct reasons of the listings that are unavailable; the skills of the
 * other listings are kept.
 */
const buildSessionSkillList = (parts: {
  readonly library: ReadonlyArray<SessionLibrarySkill>;
  readonly listings: ReadonlyArray<RepositorySkillsListing>;
  readonly libraryNote?: string;
}): SessionSkillList => {
  const libraryItems = parts.library
    .map(({ name, description }): SessionSkill => ({ source: "library", name, description }))
    .sort(compareByName);
  const listed = parts.listings.flatMap((listing) => (listing._tag === "listed" ? [listing] : []));
  const repositoryItems = listed
    .flatMap((listing) => listing.skills)
    .map((skill): SessionSkill => ({
      source: "repository",
      name: `${skill.checkoutName}:${skill.name}`,
      description: skill.description,
      path: skill.path,
    }))
    .sort(compareByName);
  const reasons = parts.listings.flatMap((listing) =>
    listing._tag === "unavailable" ? [listing.reason] : [],
  );
  const incompleteReason = [
    ...(parts.libraryNote === undefined ? [] : [parts.libraryNote]),
    ...new Set(reasons),
  ].join(" ");
  return {
    items: [...libraryItems, ...repositoryItems],
    skipped: listed.flatMap((listing) => listing.skipped),
    ...(incompleteReason === "" ? {} : { incompleteReason }),
  };
};

/**
 * Returns the listings of a new Thread's repos as the Thread's workspace would
 * give them. Each repo is listed from its main workspace, where it is the only
 * checkout, at the root. In the Thread:
 *
 * - With more than one repo, each checkout sits in a folder named after its
 *   repo, so the paths of its skills and skipped folders start with that
 *   folder. A reason that names a path keeps the path as the runner wrote it.
 * - A repo whose checkout name an earlier repo already has loses all its
 *   skills: they become skipped folders, with the reason the runner gives. The
 *   earlier repo keeps the name even when it has no skills of its own.
 *
 * `entries` are in the order the Thread would open the repos.
 */
const arrangeAsOneWorkspace = (
  entries: ReadonlyArray<{
    readonly resource: StoredRepo;
    readonly listing: RepositorySkillsListing;
  }>,
): ReadonlyArray<RepositorySkillsListing> => {
  const takenCheckoutNames = new Set<string>();
  return entries.map(({ resource, listing }) => {
    if (listing._tag === "unavailable") return listing;
    const checkoutName = formatCheckoutName(null, resource.canonicalRemote);
    const duplicateReason =
      checkoutName !== undefined && takenCheckoutNames.has(checkoutName)
        ? describeDuplicateCheckoutName(checkoutName)
        : undefined;
    if (checkoutName !== undefined) takenCheckoutNames.add(checkoutName);
    const place = (path: string): string =>
      entries.length > 1 ? `${extractRepoName(resource.canonicalRemote)}/${path}` : path;
    return {
      _tag: "listed",
      skills:
        duplicateReason === undefined
          ? listing.skills.map((skill) => ({ ...skill, path: place(skill.path) }))
          : [],
      skipped: [
        ...(duplicateReason === undefined
          ? []
          : listing.skills.map((skill) => ({ path: skill.path, reason: duplicateReason }))),
        ...listing.skipped,
      ].map((each) => ({ ...each, path: place(each.path) })),
    };
  });
};

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const sessions = yield* sessionRepository;
  const resources = yield* resourceRepository;
  const runners = yield* runnerRepository;
  const workspaces = yield* WorkspaceService;
  const connections = yield* RunnerConnections;
  const readSession = readSessionOrFail(sessions);
  const readRunner = readRunnerOrFail(runners);
  const withSql = Effect.provideService(SqlClient.SqlClient, sql);

  /**
   * Asks the runner for the repository skills of one workspace. Never fails:
   * a runner that cannot answer gives an `unavailable` listing whose reason
   * tells the user what to do.
   */
  const listRepositorySkills = (
    runner: RunnerDetail,
    workspaceId: string,
  ): Effect.Effect<RepositorySkillsListing> =>
    Effect.gen(function* () {
      if (!(runner.negotiatedCapabilities ?? []).includes(REPOSITORY_SKILLS_CAPABILITY))
        return buildUnavailableListing(
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
        return buildUnavailableListing(
          `The runner \`${runner.name}\` is offline or did not answer in time, so repository skills cannot be listed. Check that it is online and try again.`,
        );
      const { outcome } = answer.value;
      return outcome.status === "listed"
        ? { _tag: "listed", skills: outcome.skills, skipped: outcome.skipped }
        : buildUnavailableListing(
            `The runner \`${runner.name}\` could not list repository skills: ${outcome.message}`,
          );
    });

  /** Reads the repository skills of a repo's main workspace on the runner. */
  const listRepositorySkillsOfRepo = (
    runner: RunnerDetail,
    resource: StoredRepo,
  ): Effect.Effect<RepositorySkillsListing, SqlError> =>
    Effect.gen(function* () {
      const workspaceId = yield* workspaces.readReadyPrimaryId(resource.id, runner.id);
      return Option.isNone(workspaceId)
        ? buildUnavailableListing(
            `The repo \`${describeRepo(resource)}\` has no ready main workspace on the runner \`${runner.name}\`, so its repository skills cannot be listed. Provision the workspace to see them.`,
          )
        : yield* listRepositorySkills(runner, workspaceId.value);
    });

  return {
    /**
     * Returns the skills of a session: the library skills it got at its last
     * claimed start, then the skills in the checkouts of its workspace as the
     * runner reads them now. A Skill added to the library after that start is
     * not listed, because the session does not have it.
     *
     * A session that started before the controller recorded library skills
     * (migration 0087) has no record. For a Thread that is already running,
     * the current library would be wrong, so none is listed and
     * `incompleteReason` says so. A session whose start is still to come is
     * given the current library, as its start will.
     *
     * Fails with `Forbidden` when the caller lacks `session.read`, and with
     * `NotFound` when no session has the id, or its runner is gone.
     */
    querySkills: (id: string): Effect.Effect<SessionSkillList, Forbidden | NotFound | SqlError> =>
      Effect.gen(function* () {
        yield* requireGrant("session.querySkills");
        const session = yield* readSession(id);
        const recorded = yield* sessions.readLibrarySkills(id);
        const [library, libraryNote] = Option.isSome(recorded)
          ? ([recorded.value, undefined] as const)
          : // Only a Thread gets library skills (`decideSessionSkills`), so an
            // Agent's session has none to be missing.
            session.agentId === null && hasClaimedStart(session)
            ? ([[], LIBRARY_NOT_RECORDED] as const)
            : ([
                yield* withSql(decideSessionSkills({ agentId: session.agentId })),
                undefined,
              ] as const);
        const listings =
          session.workspaceId === null
            ? []
            : [
                yield* listRepositorySkills(
                  yield* readRunner(session.runnerId),
                  session.workspaceId,
                ),
              ];
        return buildSessionSkillList({
          library,
          listings,
          ...(libraryNote === undefined ? {} : { libraryNote }),
        });
      }),

    /**
     * Returns the skills a new Thread with these repos on this runner would
     * get: the library as it is now, and the skills in the main workspace of
     * each repo on the runner. When there is more than one repo, the paths
     * and checkout names are those of the Thread's workspace, where each repo
     * sits in a folder of its own (`arrangeAsOneWorkspace`). Inspects at most
     * `PREVIEW_CONCURRENCY` workspaces at a time.
     *
     * Fails with `Forbidden` when the caller lacks `workspace.read`, and with
     * `NotFound` when no runner or no resource has an id given. Fails with
     * `Validation`, with the same message as a spawn, when the repos cannot
     * share a workspace: a resource is not a repo, one is listed twice, two
     * have the same name, or a name is not a valid directory name.
     */
    previewSkills: (
      filter: SkillsPreviewFilter,
    ): Effect.Effect<SessionSkillList, Forbidden | NotFound | Validation | SqlError> =>
      Effect.gen(function* () {
        yield* requireGrant("session.previewSkills");
        const runner = yield* readRunner(filter.runnerId);
        const found = yield* resources.byIds(filter.resourceId);
        const repos: Array<StoredRepo> = [];
        for (const resourceId of filter.resourceId) {
          const resource = found.get(resourceId);
          if (resource === undefined)
            return yield* Effect.fail(createNotFoundError(NO_SUCH_RESOURCE));
          repos.push(yield* requireCheckedOut(resource));
        }
        // The checks a spawn makes, so the preview never describes a Thread that
        // cannot start.
        yield* validateCheckoutDirectories(repos);
        const library = yield* withSql(decideSessionSkills({ agentId: null }));
        const listings = yield* Effect.forEach(
          repos,
          (resource) => listRepositorySkillsOfRepo(runner, resource),
          { concurrency: PREVIEW_CONCURRENCY },
        );
        return buildSessionSkillList({
          library,
          listings: arrangeAsOneWorkspace(
            repos.map((resource, index) => ({ resource, listing: listings[index]! })),
          ),
        });
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
