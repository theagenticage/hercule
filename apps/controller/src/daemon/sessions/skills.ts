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
  MAX_REPOSITORY_SKILLS,
  REPOSITORY_SKILLS_CAPABILITY,
  type RepositorySkillsInspect,
  type RepositorySkillsPreview,
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
 * The repository part of an answer: what the runner listed, and why the list
 * may be incomplete. A runner that could not be asked, or that failed, gives no
 * skills and a reason.
 */
interface RepositorySkillsPart {
  readonly skills: ReadonlyArray<RepositorySkill>;
  readonly skipped: ReadonlyArray<SkippedRepositorySkill>;
  readonly incompleteReason?: string;
}

/** The part of the answer for a session that started before its library skills were recorded. */
const LIBRARY_NOT_RECORDED =
  "This session started before the controller recorded its library skills, so they are not listed. They are listed after the session is resumed.";

const buildUnavailablePart = (reason: string): RepositorySkillsPart => ({
  skills: [],
  skipped: [],
  incompleteReason: reason,
});

/**
 * The reason given when the runner marks its listing `truncated`: a list was
 * full when another entry came, or the listing read as many files and folders
 * as it is allowed to.
 */
const REPOSITORY_SKILLS_TRUNCATED = `Not every skill folder of the workspace is shown: a listing holds at most ${MAX_REPOSITORY_SKILLS} skills and ${MAX_REPOSITORY_SKILLS} skipped folders, and reads a limited number of files and folders.`;

const compareByName = (a: { readonly name: string }, b: { readonly name: string }): number =>
  a.name < b.name ? -1 : a.name > b.name ? 1 : 0;

/**
 * Checks whether the controller ever claimed a start of this session, so that
 * a library skills record that is missing means "recorded before this
 * feature", not "not recorded yet". The caller has already handled `queued`
 * sessions, whose start is still to come.
 *
 * - `starting`, `idle` and `busy`: a start was claimed.
 * - `exited`: a start was claimed when the process ever became ready
 *   (`startedAt`). A session that exited from the queue, or whose start
 *   failed before the process was ready, holds no skills either way, and is
 *   counted as never started.
 */
const hasClaimedStart = (session: StoredSession): boolean =>
  session.status !== "exited" || session.startedAt !== null;

/**
 * Builds the answer: the library skills first, then the repository skills,
 * each part sorted by name. `incompleteReason` joins, in one message,
 * `libraryNote` and the reason the repository part may be incomplete.
 */
const buildSessionSkillList = (parts: {
  readonly library: ReadonlyArray<SessionLibrarySkill>;
  readonly repository: RepositorySkillsPart;
  readonly libraryNote?: string;
}): SessionSkillList => {
  const libraryItems = parts.library
    .map(({ name, description }): SessionSkill => ({ source: "library", name, description }))
    .sort(compareByName);
  const repositoryItems = parts.repository.skills
    .map((skill): SessionSkill => ({
      source: "repository",
      name: `${skill.checkoutName}:${skill.name}`,
      description: skill.description,
      path: skill.path,
    }))
    .sort(compareByName);
  const incompleteReason = [parts.libraryNote, parts.repository.incompleteReason]
    .filter((note) => note !== undefined)
    .join(" ");
  return {
    items: [...libraryItems, ...repositoryItems],
    skipped: parts.repository.skipped,
    ...(incompleteReason === "" ? {} : { incompleteReason }),
  };
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
   * Returns the library skills of a session, and a note when the controller
   * has no record of which library skills the session started with. In this
   * order:
   *
   * 1. A queued session has its start still to come, and its start frame
   *    carries the library as it is then. A record from an earlier start of a
   *    resumed session is out of date, so it is not used.
   * 2. Otherwise the list recorded at the session's last claimed start.
   * 3. Otherwise a Thread that was claimed before the record existed gets no
   *    library skills and the note. Only a Thread gets library skills
   *    (`decideSessionSkills`), so an Agent's session has none to be missing.
   */
  const readSessionLibrary = (
    session: StoredSession,
  ): Effect.Effect<readonly [ReadonlyArray<SessionLibrarySkill>, string | undefined], SqlError> =>
    Effect.gen(function* () {
      const decideCurrent = () => withSql(decideSessionSkills({ agentId: session.agentId }));
      if (session.status === "queued") return [yield* decideCurrent(), undefined] as const;
      const recorded = yield* sessions.readLibrarySkills(session.id);
      if (Option.isSome(recorded)) return [recorded.value, undefined] as const;
      return session.agentId === null && hasClaimedStart(session)
        ? ([[], LIBRARY_NOT_RECORDED] as const)
        : ([yield* decideCurrent(), undefined] as const);
    });

  /**
   * Sends a request to list repository skills and returns the runner's answer
   * as the repository part. Never fails: a runner that cannot answer gives a
   * part with no skills and a reason that tells the user what to do. The
   * runner applies every listing rule (names, caps, clashes); the part holds
   * what it listed, unchanged.
   */
  const askForRepositorySkills = (
    runner: RunnerDetail,
    request: RepositorySkillsInspect | RepositorySkillsPreview,
  ): Effect.Effect<RepositorySkillsPart> =>
    Effect.gen(function* () {
      if (!(runner.negotiatedCapabilities ?? []).includes(REPOSITORY_SKILLS_CAPABILITY))
        return buildUnavailablePart(
          `The runner \`${runner.name}\` is too old to list repository skills. Update it to see them.`,
        );
      const answer = yield* connections.asked(runner.id, request, LISTING_DEADLINE);
      if (
        Option.isNone(answer) ||
        answer.value._tag !== "repositorySkillsInspection" ||
        (request._tag === "repositorySkillsInspect" &&
          answer.value.workspaceId !== request.workspaceId)
      )
        return buildUnavailablePart(
          `The runner \`${runner.name}\` is offline or did not answer in time, so repository skills cannot be listed. Check that it is online and try again.`,
        );
      const { outcome } = answer.value;
      if (outcome.status === "failed")
        return buildUnavailablePart(
          `The runner \`${runner.name}\` could not list repository skills: ${outcome.message}`,
        );
      return {
        skills: outcome.skills,
        skipped: outcome.skipped,
        ...(outcome.truncated ? { incompleteReason: REPOSITORY_SKILLS_TRUNCATED } : {}),
      };
    });

  return {
    /**
     * Returns the skills of a session: the library skills it has, then the
     * skills in the checkouts of its workspace as the runner reads them now.
     *
     * The library skills are those of the session's next start while that is
     * still to come (the session is `queued`, also when it is resumed after a
     * run), because that start records the library as it is then. Otherwise
     * they are the ones recorded at its last start, so a Skill added to the
     * library after that start is not listed: the session does not have it.
     *
     * A Thread that started before the controller recorded library skills
     * (migration 0087) has no record. The current library would be wrong
     * for it, so none is listed and `incompleteReason` says so.
     *
     * Fails with `Forbidden` when the caller lacks `session.read`, and with
     * `NotFound` when no session has the id, or its runner is gone.
     */
    querySkills: (id: string): Effect.Effect<SessionSkillList, Forbidden | NotFound | SqlError> =>
      Effect.gen(function* () {
        yield* requireGrant("session.querySkills");
        const session = yield* readSession(id);
        const [library, libraryNote] = yield* readSessionLibrary(session);
        const repository =
          session.workspaceId === null
            ? { skills: [], skipped: [] }
            : yield* askForRepositorySkills(yield* readRunner(session.runnerId), {
                _tag: "repositorySkillsInspect",
                requestId: uuidToString(mintUuid()),
                workspaceId: session.workspaceId,
              });
        return buildSessionSkillList({
          library,
          repository,
          ...(libraryNote === undefined ? {} : { libraryNote }),
        });
      }),

    /**
     * Returns the skills a new Thread with these repos on this runner would
     * get: the library as it is now, and the repository skills as the runner
     * lists them for the Thread's workspace. The controller sends the runner
     * the repos in the order the Thread would open them, each with the
     * directory it would get and its ready main workspace on the runner, if it
     * has one; the runner reads the skills and applies the listing rules, so
     * names, paths, clashes and caps are the ones a real start gets.
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
        const subdirectories = yield* validateCheckoutDirectories(repos);
        const library = yield* withSql(decideSessionSkills({ agentId: null }));
        const checkouts = yield* Effect.forEach(repos, (repo, index) =>
          Effect.map(workspaces.readReadyPrimaryId(repo.id, runner.id), (workspaceId) => ({
            remote: repo.remote,
            subdirectory: subdirectories[index] ?? null,
            workspaceId: Option.getOrNull(workspaceId),
          })),
        );
        const repository = yield* askForRepositorySkills(runner, {
          _tag: "repositorySkillsPreview",
          requestId: uuidToString(mintUuid()),
          checkouts,
        });
        return buildSessionSkillList({ library, repository });
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
