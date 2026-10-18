/**
 * The Skill Library operations of slice 1: `skill.query`, `skill.read`,
 * `skill.import` and `skill.delete` (spec 11 §2 `skill`).
 *
 * An import checks the whole archive in memory before it writes any file.
 * Its rows are then written by one transaction run under the Skill Library
 * lock, after the revision's archive is in place (`files.ts`), so the
 * created, unchanged, conflict and revised outcomes are all decided on rows
 * read in that transaction.
 *
 * Every write appends one audit entry in the same transaction as the rows it
 * describes. The entry holds names, hashes and the Skill Source, never a file.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import {
  createCapExceededError,
  createConflictError,
  createInternalError,
  createNotFoundError,
  createValidationError,
  MAX_SKILLS,
  ONLY_THE_USER_IMPORTS_SKILLS,
  SkillRevisionHash,
  type CapExceeded,
  type Conflict,
  type Forbidden,
  type Internal,
  type NotFound,
  type Skill,
  type SkillDetail,
  type SkillImportInput,
  type SkillImportResult,
  type SkillRevision,
  type SkillSource,
  type Unauthenticated,
  type Validation,
} from "@hercule/contract";
import { readSkillArchive } from "@hercule/protocol";
import { currentStamp, requireGrant, requireUserActor } from "../actor";
import { nowIso, withTransaction } from "../db";
import { AuditLog } from "../events";
import { checkSkillContent, type CheckedSkillContent } from "./content";
import {
  SkillFiles,
  SkillFilesLayer,
  type CommittedSkillChange,
  type SkillFileError,
} from "./files";
import { skillRepository, type SkillChange, type StoredSkill } from "./repository";

const CONTENT_REFUSED =
  "the skill's content is not valid; every issue says what was wrong and what to do";

/**
 * The refusal for a Skill Revision a runner may not fetch. One message covers
 * every reason, so a runner learns nothing about hashes that were never
 * applied.
 */
const NO_APPLIED_REVISION =
  "no applied Skill Revision has that hash; a runner fetches only the revisions a start frame names";

/** Returns the refusal for a name no Skill has. */
const describeUnknownSkill = (name: string): string =>
  `no skill named \`${name}\`; \`hercule skill list\` shows the skills there are`;

/**
 * Converts a failed disk operation on the files of the skill `name` into an
 * `Internal` error, and logs the original error, which holds the absolute
 * path, for the operator. The message names the action and the skill but no
 * path on the controller's disk.
 *
 * An archive missing on read gets its own message: the rows name a revision
 * whose files are gone, as after a backup restored without its `skills/`
 * folder, and importing the skill again writes them back.
 */
const reportSkillFileError = (
  name: string,
  error: SkillFileError,
): Effect.Effect<never, Internal> => {
  const isMissingArchive =
    error.action === "read" &&
    (error.cause as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
  const message = isMissingArchive
    ? `The files of the skill \`${name}\` are missing from the controller's Data Root, as after a backup restored without its \`skills/\` folder. Import the skill again to restore its files.`
    : `Could not ${error.action} the files of the skill \`${name}\` on the controller's disk. The controller's log has the details.`;
  return Effect.andThen(
    Effect.logError(`Could not ${error.action} the files of the skill \`${name}\``, error),
    Effect.fail(createInternalError(message)),
  );
};

/** Returns the Skill Source an import's query gives: GitHub when it names a repository, else `upload`. */
const buildSkillSource = (input: SkillImportInput): SkillSource =>
  input.sourceRepo === undefined || input.sourcePath === undefined
    ? { kind: "upload" }
    : {
        kind: "github",
        repo: input.sourceRepo,
        path: input.sourcePath,
        branch: input.sourceBranch ?? null,
      };

/** Returns whether two Skill Sources name the same place. */
const isSameSource = (left: SkillSource, right: SkillSource): boolean => {
  if (left.kind === "upload" || right.kind === "upload") return left.kind === right.kind;
  return left.repo === right.repo && left.path === right.path && left.branch === right.branch;
};

/** Returns a Skill's revisions sorted newest first by `field`. Revisions with no value there are left out. */
const sortNewestFirst = (
  revisions: ReadonlyArray<SkillRevision>,
  field: "appliedAt" | "createdAt",
): Array<SkillRevision> =>
  revisions
    .filter((revision) => revision[field] !== null)
    .sort((left, right) => (right[field] ?? "").localeCompare(left[field] ?? ""));

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const skills = yield* skillRepository;
  const files = yield* SkillFiles;
  const audit = yield* AuditLog;

  const findOrFail = (name: string): Effect.Effect<StoredSkill, NotFound | SqlError> =>
    Effect.flatMap(
      skills.findByName(name),
      Option.match({
        onNone: () => Effect.fail(createNotFoundError(describeUnknownSkill(name))),
        onSome: Effect.succeed,
      }),
    );

  /**
   * Reads back the Skill record a write just changed, in the write's
   * transaction, where the row is certain to exist.
   */
  const readWrittenSkill = (name: string): Effect.Effect<Skill, SqlError> =>
    Effect.flatMap(
      skills.findByName(name),
      Option.match({
        onNone: () => Effect.die(`the Skill \`${name}\` was written but cannot be read back`),
        onSome: (stored) => Effect.succeed(stored.skill),
      }),
    );

  /**
   * Sets a changed source, which clears the available revision and the last
   * update check, then deletes the `github` revisions the old source produced
   * that were never applied. Returns the deleted revisions' hashes. The
   * available hash is cleared before the revisions are deleted, so no hash
   * ever names a deleted row.
   */
  const changeSource = (
    skillId: Uint8Array,
    source: SkillSource,
    change: SkillChange,
  ): Effect.Effect<ReadonlyArray<string>, SqlError> =>
    Effect.andThen(
      skills.setSource(skillId, source, change),
      skills.deleteUnappliedGithubRevisions(skillId),
    );

  /**
   * Stores the rows of one import and returns its result, deciding the result
   * on rows read in the same transaction. The steps of spec 11 run in order,
   * and the first that applies decides.
   */
  const storeImport = (
    name: string,
    content: CheckedSkillContent,
    source: SkillSource,
    replace: boolean,
  ): Effect.Effect<CommittedSkillChange<SkillImportResult>, Conflict | CapExceeded | SqlError> =>
    Effect.gen(function* () {
      const change: SkillChange = { at: yield* nowIso, actor: yield* currentStamp };
      const hash = content.revisionHash;
      const recordImport = (
        result: SkillImportResult["result"],
        previous: Skill | undefined,
      ): Effect.Effect<void, SqlError> =>
        audit.append({
          kind: "skill.imported",
          actor: change.actor,
          payload: {
            name,
            result,
            revisionHash: hash,
            previousRevisionHash: previous?.currentRevisionHash ?? null,
            source,
            previousSource: previous?.source ?? null,
          },
          at: change.at,
        });
      const newRevision = {
        hash,
        origin: "import",
        fileCount: content.files.length,
        sizeBytes: content.sizeBytes,
        description: content.description,
        approvalEffects: content.approvalEffects,
        ...change,
      } as const;

      const found = yield* skills.findByName(name);
      if (Option.isNone(found)) {
        const count = yield* skills.count();
        if (count >= MAX_SKILLS) {
          return yield* Effect.fail(
            createCapExceededError(
              { count: count + 1, cap: MAX_SKILLS },
              `The Skill Library holds ${String(MAX_SKILLS)} skills, the most it can hold. Delete a skill you no longer use, then try again.`,
            ),
          );
        }
        const id = yield* skills.insert(name, source, change);
        yield* skills.insertRevision(id, newRevision);
        yield* skills.applyRevision(id, hash, change);
        yield* recordImport("created", undefined);
        return {
          answer: { result: "created", skill: yield* readWrittenSkill(name) },
          deletedHashes: [],
        };
      }

      const { id, skill } = found.value;
      const sourceChanged = !isSameSource(skill.source, source);
      if (hash === skill.currentRevisionHash) {
        if (!sourceChanged) return { answer: { result: "unchanged", skill }, deletedHashes: [] };
        const deletedHashes = yield* changeSource(id, source, change);
        yield* recordImport("unchanged", skill);
        return {
          answer: { result: "unchanged", skill: yield* readWrittenSkill(name) },
          deletedHashes,
        };
      }
      if (skill.currentRevisionHash !== null && !replace) {
        return yield* Effect.fail(
          createConflictError(
            `\`${name}\` exists with different content (current revision \`${skill.currentRevisionHash}\`, imported content \`${hash}\`). Import with --replace true to make the imported content current.`,
          ),
        );
      }
      // A revision of this Skill with the same content is reused, whether it
      // was current before, is available or is proposed. So importing an
      // earlier version's files again is how a user goes back to it.
      if (!(yield* skills.hasRevision(id, hash))) yield* skills.insertRevision(id, newRevision);
      yield* skills.applyRevision(id, hash, change);
      const deletedHashes = sourceChanged ? yield* changeSource(id, source, change) : [];
      yield* recordImport("revised", skill);
      return {
        answer: { result: "revised", skill: yield* readWrittenSkill(name) },
        deletedHashes,
      };
    });

  return {
    /** Returns every Skill in the library, sorted by name. */
    query: (): Effect.Effect<{ readonly items: ReadonlyArray<Skill> }, Forbidden | SqlError> =>
      Effect.gen(function* () {
        yield* requireGrant("skill.query");
        return { items: yield* skills.list() };
      }),

    /**
     * Returns a Skill with its current revision's files and `SKILL.md`, its
     * history, and the revisions waiting to be applied. Fails with:
     *
     * - `NotFound` when no Skill has the name, which is always so for the
     *   built-in skill;
     * - `Internal` when its files cannot be read, with a message that says
     *   to import the skill again when its archive is missing.
     */
    read: (name: string): Effect.Effect<SkillDetail, Forbidden | NotFound | Internal | SqlError> =>
      Effect.gen(function* () {
        yield* requireGrant("skill.read");
        // Under the lock, so a delete that commits after the rows are read
        // cannot remove the current revision's archive before it is read.
        return yield* files
          .withLibraryLock(
            Effect.gen(function* () {
              const { skill, revisions } = yield* withTransaction(
                sql,
                Effect.gen(function* () {
                  const stored = yield* findOrFail(name);
                  return { skill: stored.skill, revisions: yield* skills.listRevisions(stored.id) };
                }),
              );
              const current =
                skill.currentRevisionHash === null
                  ? null
                  : yield* files.readRevision(skill.currentRevisionHash);
              return {
                skill,
                files: current?.files ?? [],
                skillMd: current?.skillMd ?? null,
                history: sortNewestFirst(revisions, "appliedAt"),
                availableRevision:
                  revisions.find(
                    (revision) => revision.revisionHash === skill.availableRevisionHash,
                  ) ?? null,
                proposedRevisions: sortNewestFirst(
                  revisions.filter(
                    (revision) => revision.origin === "session" && revision.appliedAt === null,
                  ),
                  "createdAt",
                ),
              };
            }),
          )
          .pipe(Effect.catchTag("SkillFileError", (error) => reportSkillFileError(name, error)));
      }),

    /**
     * Imports one skill from its tar archive and returns what the import did:
     * `created`, `revised` or `unchanged`. Every import also sets the Skill's
     * source from the input. Fails with:
     *
     * - `Forbidden` when the caller is not the user;
     * - `Validation` when the archive cannot be read, or its content breaks
     *   any content rule, with every broken rule listed;
     * - `Conflict` when the Skill's current revision has other content and
     *   `replace` is not `true`;
     * - `CapExceeded` when the name is new and the library is full;
     * - `Internal` when the archive cannot be written.
     */
    import: (
      input: SkillImportInput,
      archive: Uint8Array,
    ): Effect.Effect<
      SkillImportResult,
      Unauthenticated | Forbidden | Validation | Conflict | CapExceeded | Internal | SqlError
    > =>
      Effect.gen(function* () {
        yield* requireUserActor("skill.import", ONLY_THE_USER_IMPORTS_SKILLS);
        const entries = yield* Effect.mapError(readSkillArchive(archive), (error) =>
          createValidationError([{ path: [], message: error.message }], error.message),
        );
        const content = yield* Effect.mapError(checkSkillContent(input.name, entries), (error) =>
          createValidationError(
            error.issues.map((message) => ({ path: [], message })),
            CONTENT_REFUSED,
          ),
        );
        return yield* files
          .publish(
            content,
            withTransaction(
              sql,
              storeImport(input.name, content, buildSkillSource(input), input.replace === true),
            ),
          )
          .pipe(
            Effect.catchTag("SkillFileError", (error) => reportSkillFileError(input.name, error)),
          );
      }),

    /**
     * Returns the archive bytes of the Skill Revision with this hash, for a
     * runner that loads the revision into a session. Fails with:
     *
     * - `NotFound` when the hash is not 64 lowercase hex characters, when no
     *   revision has it, when the revision was never applied, or when its
     *   archive is missing from the Data Root;
     * - `Internal` when the archive cannot be read for another reason.
     *
     * A revision that is no longer current is still served: a session that
     * started on it keeps it until its next start, and a resume on another
     * runner fetches it again. The caller has already checked the runner's
     * credential. Any runner may fetch any applied revision, because the
     * library is shared by every Thread on every runner.
     *
     * The check and the read run under the Skill Library lock, so a delete
     * that commits meanwhile cannot remove the archive between them.
     */
    readAppliedRevisionArchive: (
      hash: string,
    ): Effect.Effect<Uint8Array, NotFound | Internal | SqlError> =>
      Schema.is(SkillRevisionHash)(hash)
        ? files.withLibraryLock(
            Effect.gen(function* () {
              if (!(yield* skills.isRevisionApplied(hash))) {
                return yield* Effect.fail(createNotFoundError(NO_APPLIED_REVISION));
              }
              // A missing archive is logged too: the rows name a revision whose
              // files are gone, as after a backup restored without its
              // `skills/` folder, and the operator needs to know.
              return yield* files.readArchive(hash).pipe(
                Effect.tapError((error) =>
                  Effect.logError(
                    `Could not read the archive of the Skill Revision ${hash}`,
                    error,
                  ),
                ),
                Effect.catchTag("SkillFileError", (error) =>
                  Effect.fail(
                    (error.cause as NodeJS.ErrnoException | undefined)?.code === "ENOENT"
                      ? createNotFoundError(NO_APPLIED_REVISION)
                      : createInternalError(
                          "Could not read the Skill Revision's archive on the controller's disk. The controller's log has the details.",
                        ),
                  ),
                ),
              );
            }),
          )
        : Effect.fail(createNotFoundError(NO_APPLIED_REVISION)),

    /**
     * Deletes a Skill and every revision it has, then removes the revisions'
     * archives that no other Skill's revision names. Fails with `NotFound`
     * when no Skill has the name.
     */
    delete: (name: string): Effect.Effect<Record<string, never>, Forbidden | NotFound | SqlError> =>
      Effect.gen(function* () {
        yield* requireGrant("skill.delete");
        const deletedHashes = yield* withTransaction(
          sql,
          Effect.gen(function* () {
            const stored = yield* findOrFail(name);
            const hashes = yield* skills.delete(stored.id);
            const at = yield* nowIso;
            yield* audit.append({
              kind: "skill.deleted",
              actor: yield* currentStamp,
              payload: { name, revisionHashes: hashes },
              at,
            });
            return hashes;
          }),
        );
        yield* files.removeDeletedRevisionArchives(deletedHashes);
        return {};
      }),
  };
});

/** The Skill Library operations. */
export class SkillService extends Context.Service<SkillService, Effect.Success<typeof make>>()(
  "hercule/controller/skills/SkillService",
) {}

/** The Skill Library operations, with the `SkillFiles` they write through. */
export const SkillServiceLayer = Layer.effect(SkillService)(make).pipe(
  Layer.provide(SkillFilesLayer),
);
