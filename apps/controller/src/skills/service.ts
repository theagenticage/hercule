/**
 * The Skill Library operations: `skill.query`, `skill.read`, `skill.import`,
 * `skill.propose`, `skill.delete`, `skill.check`, `skill.diff`, `skill.apply`,
 * `skill.reject` and `skill.applyUpdates` (spec 11 §2 `skill`).
 *
 * An import or a proposal checks the whole archive in memory before it writes
 * any file. Its rows are then written by one transaction run under the Skill
 * Library lock, after the revision's archive is in place (`files.ts`), so the
 * created, unchanged, conflict and revised outcomes of an import, and the
 * proposed and unchanged outcomes of a proposal, are all decided on rows read
 * in that transaction.
 *
 * A session that has read third-party messages (a tainted session) is refused
 * every operation that changes the library and needs `skill.apply`: `apply`,
 * `applyUpdates`, `reject` and `delete`. The check runs inside the write
 * transaction, so a taint committed meanwhile cannot slip in between the
 * check and the write (spec 13 §10).
 *
 * Every write appends one audit entry in the same transaction as the rows it
 * describes. The entry holds names, hashes and the Skill Source, never a file.
 * An update check appends none; it announces the Skill it changed on the
 * `skill` live topic itself (`update-check.ts`).
 */
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FiberSet from "effect/FiberSet";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";
import {
  createCapExceededError,
  createConflictError,
  createForbiddenError,
  createInternalError,
  createInvalidStateError,
  createNotFoundError,
  createValidationError,
  MAX_PROPOSED_SKILL_REVISIONS,
  MAX_SKILLS,
  ONLY_A_SESSION_PROPOSES_SKILLS,
  ONLY_THE_USER_IMPORTS_SKILLS,
  SkillRevisionHash,
  type CapExceeded,
  type Conflict,
  type Forbidden,
  type Internal,
  type InvalidState,
  type NotFound,
  type Skill,
  type SkillApplyUpdatesInput,
  type SkillCheckInput,
  type SkillDetail,
  type SkillImportInput,
  type SkillImportResult,
  type SkillProposeInput,
  type SkillProposeResult,
  type SkillRevision,
  type SkillRevisionDiff,
  type SkillSource,
  type Unauthenticated,
  type Validation,
} from "@hercule/contract";
import { readSkillArchive } from "@hercule/protocol";
import { CurrentActor, currentStamp, requireGrant, requireUserActor, type Actor } from "../actor";
import { nowIso, withTransaction } from "../db";
import { AuditLog } from "../events";
import { sessionTaint } from "../taint";
import { checkSkillContent, type CheckedSkillContent } from "./content";
import { computeSkillFileChanges } from "./diff";
import {
  SkillFiles,
  SkillFilesLayer,
  type CommittedSkillChange,
  type SkillFileError,
} from "./files";
import {
  skillRepository,
  type SkillChange,
  type SkillRevisionWithEffects,
  type StoredSkill,
} from "./repository";
import { isSameSource } from "./source";
import { makeSkillUpdateChecks } from "./update-check";

const CONTENT_REFUSED =
  "the skill's content is not valid; every issue says what was wrong and what to do";

/**
 * The refusal for a Skill Revision a runner may not fetch. One message covers
 * every reason, so a runner learns nothing about hashes that were never
 * applied.
 */
const NO_APPLIED_REVISION =
  "no applied Skill Revision has that hash; a runner fetches only the revisions a start frame names";

const NO_ACTOR = { _tag: "none" } as const;

/** The refusal of `skill.apply` for a tainted session that applies a proposed revision. */
const TAINTED_SESSION_APPLIES_PROPOSAL =
  "This session has read third-party messages, so it cannot apply skills. The revision stays proposed: apply it on the Skills screen, or from a session that has not read third-party messages.";

/** The refusal of every other change to the library by a tainted session. */
const TAINTED_SESSION_CHANGES_LIBRARY =
  "A session that has read third-party messages cannot change the Skill Library. Ask the user to do it on the Skills screen.";

/** Returns whether the revision was proposed by a session and never applied. */
const isProposed = (revision: SkillRevision): boolean =>
  revision.origin === "session" && revision.appliedAt === null;

/** Joins names for a message: `a`, `a and b`, `a, b and c`. */
const joinNames = (names: ReadonlyArray<string>): string =>
  names.length <= 1
    ? (names[0] ?? "")
    : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;

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

/** Returns the refusal for a hash that is not a revision of the Skill `name`. */
const describeUnknownRevision = (name: string, hash: string): string =>
  `\`${name}\` has no revision \`${hash}\`; \`hercule skill read ${name}\` shows its revisions`;

/**
 * Returns why `skill.apply` refuses a revision that is neither available nor
 * proposed, or undefined when the revision waits to be applied.
 */
const describeRevisionNotWaiting = (
  skill: Skill,
  { revision }: SkillRevisionWithEffects,
): string | undefined => {
  const hash = revision.revisionHash;
  if (hash === skill.availableRevisionHash) return undefined;
  if (revision.origin === "session" && revision.appliedAt === null) return undefined;
  if (hash === skill.currentRevisionHash) {
    return `\`${hash}\` is already the current revision of \`${skill.name}\`, so there is nothing to apply.`;
  }
  if (revision.appliedAt !== null) {
    return `\`${hash}\` is an earlier revision of \`${skill.name}\`, not one waiting to be applied. To go back to it, import its files again with \`hercule skill import <folder> --replace true\`.`;
  }
  return `\`${hash}\` is not waiting to be applied to \`${skill.name}\`: only its available update or a proposed revision can be applied.`;
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
  const taint = yield* sessionTaint;
  const updateChecks = yield* makeSkillUpdateChecks;
  // A check that `skill.check` starts runs on a fiber owned by this layer,
  // not by the request, which has answered long before the check ends. The
  // fibers end with the controller.
  const checkFibers = yield* FiberSet.make<void, never>();

  /**
   * Starts checks of these Skills in the background and returns at once. A
   * failure is logged.
   *
   * The fiber starts from the request's context, because that context holds
   * the live topics, provided beside this service, that the check's result
   * is announced on. It runs with no actor: what it stores is stamped
   * `system`.
   */
  const startChecks = (candidates: ReadonlyArray<StoredSkill>): Effect.Effect<void> =>
    Effect.asVoid(
      FiberSet.run(
        checkFibers,
        updateChecks.checkSkills(candidates).pipe(
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.void
              : Effect.logError("An update check of the Skill Library failed", cause),
          ),
          Effect.provideService(CurrentActor, NO_ACTOR),
        ),
      ),
    );

  /** Returns the Skill's revision with this hash, or fails with `NotFound`. */
  const findRevisionOrFail = (
    stored: StoredSkill,
    hash: string,
  ): Effect.Effect<SkillRevisionWithEffects, NotFound | SqlError> =>
    Effect.flatMap(
      skills.findRevision(stored.id, hash),
      Option.match({
        onNone: () =>
          Effect.fail(createNotFoundError(describeUnknownRevision(stored.skill.name, hash))),
        onSome: Effect.succeed,
      }),
    );

  /**
   * Makes the Skill's revision with this hash current, appends the
   * `skill.applied` entry, and returns the Skill record as written. The
   * caller has checked that the revision waits to be applied, in the same
   * transaction.
   */
  const applyWaitingRevision = (
    stored: StoredSkill,
    hash: string,
  ): Effect.Effect<Skill, SqlError> =>
    Effect.gen(function* () {
      const change: SkillChange = { at: yield* nowIso, actor: yield* currentStamp };
      yield* skills.applyRevision(stored.id, hash, change);
      yield* audit.append({
        kind: "skill.applied",
        actor: change.actor,
        payload: {
          name: stored.skill.name,
          revisionHash: hash,
          previousRevisionHash: stored.skill.currentRevisionHash,
        },
        at: change.at,
        record: { topic: "skill", id: stored.skill.name },
      });
      return yield* readWrittenSkill(stored.skill.name);
    });

  /**
   * Fails with `Forbidden` naming `skill.apply` when the caller is a tainted
   * session, with the message for applying a proposed revision when
   * `proposedRevision` is true and the general one otherwise. Run it inside
   * the write transaction, so the flag it reads cannot change before the
   * write commits.
   */
  const refuseTaintedCaller = (
    proposedRevision = false,
  ): Effect.Effect<void, Forbidden | SqlError> =>
    Effect.flatMap(taint.isCallerTainted, (tainted) =>
      tainted
        ? Effect.fail(
            createForbiddenError(
              "skill.apply",
              proposedRevision ? TAINTED_SESSION_APPLIES_PROPOSAL : TAINTED_SESSION_CHANGES_LIBRARY,
            ),
          )
        : Effect.void,
    );

  /**
   * Requires the caller to hold `skill.write` and to be a session, and
   * returns the session. The user and a run hold every grant but are refused,
   * because a proposal the user files for themselves would only be a detour
   * around an import.
   */
  const requireSessionProposer = Effect.flatMap(
    requireGrant("skill.propose"),
    (actor): Effect.Effect<Actor, Forbidden> =>
      actor._tag === "session"
        ? Effect.succeed(actor)
        : Effect.fail(createForbiddenError("skill.write", ONLY_A_SESSION_PROPOSES_SKILLS)),
  );

  /**
   * Reads an archive and checks its content as the skill `name`, failing with
   * `Validation` listing every problem. Nothing is written.
   */
  const readCheckedContent = (
    name: string,
    archive: Uint8Array,
  ): Effect.Effect<CheckedSkillContent, Validation> =>
    Effect.gen(function* () {
      const entries = yield* Effect.mapError(readSkillArchive(archive), (error) =>
        createValidationError([{ path: [], message: error.message }], error.message),
      );
      return yield* Effect.mapError(checkSkillContent(name, entries), (error) =>
        createValidationError(
          error.issues.map((message) => ({ path: [], message })),
          CONTENT_REFUSED,
        ),
      );
    });

  /**
   * Stores the rows of one proposal and returns its result, deciding it on
   * rows read in the same transaction. A hash the Skill already holds is
   * `unchanged` before any cap applies. A proposal never changes the Skill's
   * source or current revision.
   */
  const storeProposal = (
    name: string,
    content: CheckedSkillContent,
  ): Effect.Effect<CommittedSkillChange<SkillProposeResult>, CapExceeded | SqlError> =>
    Effect.gen(function* () {
      const hash = content.revisionHash;
      const found = yield* skills.findByName(name);
      if (Option.isSome(found) && (yield* skills.hasRevision(found.value.id, hash))) {
        return { answer: { result: "unchanged", skill: found.value.skill }, releasedHashes: [] };
      }

      const proposed = yield* skills.listProposedCounts();
      const proposedTotal = proposed.reduce((total, { count }) => total + count, 0);
      if (proposedTotal >= MAX_PROPOSED_SKILL_REVISIONS) {
        return yield* Effect.fail(
          createCapExceededError(
            { count: proposedTotal + 1, cap: MAX_PROPOSED_SKILL_REVISIONS },
            `${String(proposedTotal)} proposed revisions already wait for review, in ${joinNames(proposed.map((entry) => `\`${entry.name}\``))}. Ask the user to apply or reject them on the Skills screen before you propose another.`,
          ),
        );
      }

      const change: SkillChange = { at: yield* nowIso, actor: yield* currentStamp };
      let id: Uint8Array;
      if (Option.isSome(found)) {
        id = found.value.id;
      } else {
        const count = yield* skills.count();
        if (count >= MAX_SKILLS) {
          return yield* Effect.fail(
            createCapExceededError(
              { count: count + 1, cap: MAX_SKILLS },
              `The Skill Library holds ${String(MAX_SKILLS)} skills, the most it can hold. Delete a skill you no longer use, then try again.`,
            ),
          );
        }
        id = yield* skills.insert(name, { kind: "upload" }, change);
      }
      const includesThirdPartyContent = yield* taint.isCallerTainted;
      yield* skills.insertRevision(id, {
        hash,
        origin: "session",
        fileCount: content.files.length,
        sizeBytes: content.sizeBytes,
        description: content.description,
        approvalEffects: content.approvalEffects,
        includesThirdPartyContent,
        ...change,
      });
      // A new Skill's row already holds this change; an existing one gained a
      // proposed revision, which its record counts.
      if (Option.isSome(found)) yield* skills.touch(id, change);
      yield* audit.append({
        kind: "skill.proposed",
        actor: change.actor,
        payload: { name, revisionHash: hash, includesThirdPartyContent },
        at: change.at,
        record: { topic: "skill", id: name },
      });
      return {
        answer: { result: "proposed", skill: yield* readWrittenSkill(name) },
        releasedHashes: [],
      };
    });

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
      skills.deleteUnappliedGithubRevisions(skillId, null),
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
          record: { topic: "skill", id: name },
        });
      const newRevision = {
        hash,
        origin: "import",
        fileCount: content.files.length,
        sizeBytes: content.sizeBytes,
        description: content.description,
        approvalEffects: content.approvalEffects,
        includesThirdPartyContent: false,
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
          releasedHashes: [],
        };
      }

      const { id, skill } = found.value;
      const sourceChanged = !isSameSource(skill.source, source);
      if (hash === skill.currentRevisionHash) {
        if (!sourceChanged) return { answer: { result: "unchanged", skill }, releasedHashes: [] };
        const releasedHashes = yield* changeSource(id, source, change);
        yield* recordImport("unchanged", skill);
        return {
          answer: { result: "unchanged", skill: yield* readWrittenSkill(name) },
          releasedHashes,
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
      const releasedHashes = sourceChanged ? yield* changeSource(id, source, change) : [];
      yield* recordImport("revised", skill);
      return {
        answer: { result: "revised", skill: yield* readWrittenSkill(name) },
        releasedHashes,
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
        const content = yield* readCheckedContent(input.name, archive);
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
     * Files the skill in the archive as a proposed Skill Revision, which
     * waits for the user to apply it, and returns `proposed` or `unchanged`
     * with the Skill. The Skill is created, with no current revision, when
     * no Skill has the name. Fails with:
     *
     * - `Forbidden` when the caller is not a session holding `skill.write`:
     *   the user and a run are refused, and the message says to import;
     * - `Validation` when the archive cannot be read, or its content breaks
     *   any content rule, with every broken rule listed;
     * - `CapExceeded` when the library already holds the most proposed
     *   revisions, naming every Skill that has one, or the name is new and
     *   the library is full;
     * - `Internal` when the archive cannot be written.
     *
     * A revision the Skill already holds, whatever its state, is `unchanged`
     * and stores nothing. A session that has read third-party messages may
     * propose; its revision is marked `includesThirdPartyContent`.
     */
    propose: (
      input: SkillProposeInput,
      archive: Uint8Array,
    ): Effect.Effect<
      SkillProposeResult,
      Unauthenticated | Forbidden | Validation | CapExceeded | Internal | SqlError
    > =>
      Effect.gen(function* () {
        yield* requireSessionProposer;
        const content = yield* readCheckedContent(input.name, archive);
        return yield* files
          .publish(content, withTransaction(sql, storeProposal(input.name, content)))
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
     * when no Skill has the name, and with `Forbidden` when the caller is a
     * tainted session.
     */
    delete: (name: string): Effect.Effect<Record<string, never>, Forbidden | NotFound | SqlError> =>
      Effect.gen(function* () {
        yield* requireGrant("skill.delete");
        const deletedHashes = yield* withTransaction(
          sql,
          Effect.gen(function* () {
            yield* refuseTaintedCaller();
            const stored = yield* findOrFail(name);
            const hashes = yield* skills.delete(stored.id);
            const at = yield* nowIso;
            yield* audit.append({
              kind: "skill.deleted",
              actor: yield* currentStamp,
              payload: { name, revisionHashes: hashes },
              at,
              record: { topic: "skill", id: name },
            });
            return hashes;
          }),
        );
        yield* files.removeDeletedRevisionArchives(deletedHashes);
        return {};
      }),

    /**
     * Starts an update check of the named Skill, or of every Skill with a
     * GitHub source when `name` is absent, and returns at once. Fails with:
     *
     * - `NotFound` when no Skill has the name;
     * - `InvalidState` when the named Skill has an `upload` source, which has
     *   nothing to check.
     */
    check: (
      input: SkillCheckInput,
    ): Effect.Effect<Record<string, never>, Forbidden | NotFound | InvalidState | SqlError> =>
      Effect.gen(function* () {
        yield* requireGrant("skill.check");
        if (input.name === undefined) {
          yield* startChecks(yield* skills.listGithubSkills());
          return {};
        }
        const stored = yield* findOrFail(input.name);
        if (stored.skill.source.kind === "upload") {
          return yield* Effect.fail(
            createInvalidStateError(
              `\`${input.name}\` was uploaded, not imported from GitHub, so there is no source to check. Import it from a folder with a \`.skill-lock.json\` to give it a GitHub source.`,
            ),
          );
        }
        yield* startChecks([stored]);
        return {};
      }),

    /**
     * Checks every Skill with a GitHub source whose last check ended at or
     * before `at`, or that was never checked, and returns once those checks
     * have ended. Never fails: a check's failure is its Skill's `checkError`.
     *
     * The periodic check calls it, as the system, so it asks for no grant.
     */
    checkSkillsNotCheckedSince: (at: string): Effect.Effect<void, SqlError> =>
      Effect.flatMap(skills.listGithubSkills(), (candidates) =>
        updateChecks.checkSkills(
          candidates.filter(
            ({ skill }) => skill.lastCheckedAt === null || skill.lastCheckedAt <= at,
          ),
        ),
      ),

    /**
     * Returns what the Skill's revision with this hash changes compared with
     * its current revision: the revision's approval effects, and one entry
     * per file that differs. Fails with `NotFound` when no Skill has the name
     * or it has no revision with the hash, and with `Internal` when an
     * archive cannot be read.
     */
    diff: (input: {
      readonly name: string;
      readonly revisionHash: string;
    }): Effect.Effect<SkillRevisionDiff, Forbidden | NotFound | Internal | SqlError> =>
      Effect.gen(function* () {
        yield* requireGrant("skill.diff");
        // Under the lock, so a delete that commits after the rows are read
        // cannot remove an archive before it is read.
        const { approvalEffects, current, revision } = yield* files
          .withLibraryLock(
            Effect.gen(function* () {
              const { skill, found } = yield* withTransaction(
                sql,
                Effect.gen(function* () {
                  const stored = yield* findOrFail(input.name);
                  return {
                    skill: stored.skill,
                    found: yield* findRevisionOrFail(stored, input.revisionHash),
                  };
                }),
              );
              return {
                approvalEffects: found.approvalEffects,
                current:
                  skill.currentRevisionHash === null
                    ? null
                    : yield* files.readRevisionFiles(skill.currentRevisionHash),
                revision: yield* files.readRevisionFiles(input.revisionHash),
              };
            }),
          )
          .pipe(
            Effect.catchTag("SkillFileError", (error) => reportSkillFileError(input.name, error)),
          );
        return { approvalEffects, files: computeSkillFileChanges(current, revision) };
      }),

    /**
     * Makes the Skill's available revision, or one of its proposed revisions,
     * current, and returns the Skill record. Fails with:
     *
     * - `NotFound` when no Skill has the name, or it has no revision with the
     *   hash. When the Skill has an available update, the message says a
     *   newer update replaced the one chosen;
     * - `InvalidState` when the revision is neither available nor proposed,
     *   with a message that says how to go back to an earlier revision;
     * - `Forbidden` when the caller is a tainted session. The message depends
     *   on whether the revision is a proposed one.
     */
    apply: (input: {
      readonly name: string;
      readonly revisionHash: string;
    }): Effect.Effect<Skill, Forbidden | NotFound | InvalidState | SqlError> =>
      Effect.gen(function* () {
        yield* requireGrant("skill.apply");
        return yield* withTransaction(
          sql,
          Effect.gen(function* () {
            const stored = yield* findOrFail(input.name);
            const revision = yield* skills.findRevision(stored.id, input.revisionHash);
            yield* refuseTaintedCaller(
              Option.isSome(revision) && isProposed(revision.value.revision),
            );
            if (Option.isNone(revision)) {
              // A check that finds a newer update deletes the one it replaces,
              // so the update the user chose may be gone.
              return yield* Effect.fail(
                createNotFoundError(
                  stored.skill.availableRevisionHash === null
                    ? describeUnknownRevision(input.name, input.revisionHash)
                    : `\`${input.name}\` has a newer update than the one you chose. Read the skill again and apply that one.`,
                ),
              );
            }
            const found = revision.value;
            const refusal = describeRevisionNotWaiting(stored.skill, found);
            if (refusal !== undefined) return yield* Effect.fail(createInvalidStateError(refusal));
            return yield* applyWaitingRevision(stored, input.revisionHash);
          }),
        );
      }),

    /**
     * Deletes one of the Skill's proposed revisions and returns `{}`. A
     * revision that is also the Skill's available one is no longer available.
     * When it was the last proposed revision of a Skill with no current
     * revision, the Skill goes too. The archives no row names any more are
     * removed after the commit. Fails with:
     *
     * - `NotFound` when no Skill has the name, or it has no revision with
     *   the hash;
     * - `InvalidState` when the revision is not a proposed one;
     * - `Forbidden` when the caller is a tainted session.
     */
    reject: (input: {
      readonly name: string;
      readonly revisionHash: string;
    }): Effect.Effect<Record<string, never>, Forbidden | NotFound | InvalidState | SqlError> =>
      Effect.gen(function* () {
        yield* requireGrant("skill.reject");
        const deletedHashes = yield* withTransaction(
          sql,
          Effect.gen(function* () {
            yield* refuseTaintedCaller();
            const stored = yield* findOrFail(input.name);
            const { id, skill } = stored;
            const { revision } = yield* findRevisionOrFail(stored, input.revisionHash);
            if (!isProposed(revision)) {
              return yield* Effect.fail(
                createInvalidStateError(
                  `\`${input.revisionHash}\` is not a proposed revision of \`${input.name}\`, and only a proposed revision can be rejected.`,
                ),
              );
            }
            const change: SkillChange = { at: yield* nowIso, actor: yield* currentStamp };
            if (skill.availableRevisionHash === input.revisionHash) {
              yield* skills.setAvailableRevision(id, null, change);
            }
            yield* skills.deleteRevision(id, input.revisionHash);
            const skillDeleted = skill.currentRevisionHash === null && skill.proposedCount === 1;
            const hashes = skillDeleted ? yield* skills.delete(id) : [];
            if (!skillDeleted) yield* skills.touch(id, change);
            yield* audit.append({
              kind: "skill.rejected",
              actor: change.actor,
              payload: { name: input.name, revisionHash: input.revisionHash, skillDeleted },
              at: change.at,
              record: { topic: "skill", id: input.name },
            });
            return [input.revisionHash, ...hashes];
          }),
        );
        yield* files.removeDeletedRevisionArchives(deletedHashes);
        return {};
      }),

    /**
     * Makes each named Skill's available revision current, all in one
     * transaction, and returns the Skill records it changed. Each update
     * names the available revision the caller showed the user. Fails, and
     * applies nothing, with:
     *
     * - `NotFound` when no Skill has one of the names;
     * - `Conflict` when a Skill's available revision is no longer the one
     *   named, because a check found a newer one since;
     * - `Forbidden` when the caller is a tainted session.
     */
    applyUpdates: (
      input: SkillApplyUpdatesInput,
    ): Effect.Effect<
      { readonly items: ReadonlyArray<Skill> },
      Forbidden | NotFound | Conflict | SqlError
    > =>
      Effect.gen(function* () {
        yield* requireGrant("skill.applyUpdates");
        return yield* withTransaction(
          sql,
          Effect.gen(function* () {
            yield* refuseTaintedCaller();
            const found = yield* Effect.forEach(input.updates, (update) =>
              Effect.map(findOrFail(update.name), (stored) => ({ stored, update })),
            );
            for (const { stored, update } of found) {
              const available = stored.skill.availableRevisionHash;
              if (available !== update.revisionHash) {
                return yield* Effect.fail(
                  createConflictError(
                    available === null
                      ? `\`${update.name}\` has no update waiting any more. Read the updates again and confirm.`
                      : `\`${update.name}\` has a newer update than the one you confirmed. Read the updates again and confirm.`,
                  ),
                );
              }
            }
            const items = yield* Effect.forEach(found, ({ stored, update }) =>
              applyWaitingRevision(stored, update.revisionHash),
            );
            return { items };
          }),
        );
      }),
  };
});

/** The Skill Library operations. */
export class SkillService extends Context.Service<SkillService, Effect.Success<typeof make>>()(
  "hercule/controller/skills/SkillService",
) {}

/**
 * The Skill Library operations, with the `SkillFiles` they write through. The
 * caller provides the `GithubSkillSources` the update check reads.
 */
export const SkillServiceLayer = Layer.effect(SkillService)(make).pipe(
  Layer.provide(SkillFilesLayer),
);
