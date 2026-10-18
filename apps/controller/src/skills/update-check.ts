/**
 * The update check of Skills with a GitHub source (spec 11 §2 `skill.check`,
 * spec 04 "Skill rows").
 *
 * A check pass groups its Skills by repository and branch. Each group reads
 * the branch's commit once. A Skill whose stored upstream commit is that
 * commit downloads nothing. The repository is downloaded once for the rest of
 * the group, and each Skill's folder is checked with the content rules.
 *
 * One check runs at a time per Skill. A pass that finds a Skill's check
 * running waits for it to end. When the running check began with the same
 * source, the pass takes its result as its own. Otherwise the running check's
 * result is dropped, so the pass then checks the Skill again.
 *
 * The results of one group are written by one transaction, so a group's
 * results reach clients as one live push. The transaction reads the group's
 * Skills again and drops the result of a Skill that is gone or whose source
 * changed since the check began. A check runs with no actor: what it stores
 * is stamped `system`.
 */
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import type { SkillSource } from "@hercule/contract";
import { SYSTEM_ACTOR } from "../actor";
import { announce, nowIso, withTransaction } from "../db";
import { checkSkillContent, type CheckedSkillContent } from "./content";
import { SkillFiles, type SkillFileError } from "./files";
import { GithubSkillSources, type DownloadedSkillTree } from "./github";
import { skillRepository, type SkillCheckRecord, type StoredSkill } from "./repository";
import { isSameSource } from "./source";

/** How many repositories one pass reads from GitHub at once. */
const MAX_CONCURRENT_REPOSITORIES = 4;

/**
 * The longest check error a check stores, in characters. A tree can break
 * thousands of rules, and a path in an issue can be long, so the error lists
 * the issues that fit and counts the rest.
 */
const MAX_CHECK_ERROR_LENGTH = 2000;

/** The check error of a Skill whose new revision could not be written to the Data Root. */
const ARCHIVE_NOT_STORED_MESSAGE =
  "The check found an update, but the controller could not store it on its disk. The controller's log has the details; the next check tries again.";

type GithubSkillSource = Extract<SkillSource, { readonly kind: "github" }>;

/** A Skill a check reads, with its GitHub source as the check began with it. */
interface GithubSkill {
  readonly stored: StoredSkill;
  readonly source: GithubSkillSource;
}

/** The check running for one Skill: the source it began with, and a signal that completes when it ends. */
interface RunningCheck {
  readonly source: GithubSkillSource;
  readonly ended: Deferred.Deferred<void>;
}

/** The Skills of one pass that share a repository and branch, and the signal their checks end with. */
interface RepositoryGroup {
  readonly repo: string;
  readonly branch: string | null;
  readonly skills: Array<GithubSkill>;
  readonly ended: Deferred.Deferred<void>;
}

/**
 * How one Skill's check ended:
 *
 * - `Unchanged`: the branch is at `commit`, the upstream commit the Skill
 *   had when the pass read it, so nothing was downloaded.
 * - `Unreadable`: GitHub could not be read, so no tree was checked.
 * - `Refused`: the tree at `commit` cannot become a revision; `issues` say why.
 * - `Accepted`: the tree at `commit` passed the content rules.
 */
type CheckOutcome =
  | { readonly _tag: "Unchanged"; readonly commit: string }
  | { readonly _tag: "Unreadable"; readonly message: string }
  | { readonly _tag: "Refused"; readonly issues: ReadonlyArray<string>; readonly commit: string }
  | { readonly _tag: "Accepted"; readonly content: CheckedSkillContent; readonly commit: string };

/** One Skill's check and how it ended. */
interface CheckResult {
  readonly checked: GithubSkill;
  readonly outcome: CheckOutcome;
}

/**
 * Joins `issues` into one check error of at most about 2,000 characters. The
 * issues that fit are listed in order, and the rest are counted, as in
 * "And 12 more issues.". A first issue longer than the limit is cut and
 * ends in "…".
 */
const buildCheckError = (issues: ReadonlyArray<string>): string => {
  let message = "";
  let listed = 0;
  for (const issue of issues) {
    const next = listed === 0 ? issue : `${message} ${issue}`;
    if (listed > 0 && next.length > MAX_CHECK_ERROR_LENGTH) break;
    message = next;
    listed += 1;
  }
  if (message.length > MAX_CHECK_ERROR_LENGTH) {
    // A cut between the two halves of a surrogate pair would leave half a character.
    message = `${message.slice(0, MAX_CHECK_ERROR_LENGTH).replace(/[\uD800-\uDBFF]$/, "")}…`;
  }
  const rest = issues.length - listed;
  return rest === 0 ? message : `${message} And ${rest} more ${rest === 1 ? "issue" : "issues"}.`;
};

/**
 * Builds the update check. Its checks run on the caller's fiber; the caller
 * decides whether to wait for them.
 */
export const makeSkillUpdateChecks = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const skills = yield* skillRepository;
  const files = yield* SkillFiles;
  const github = yield* GithubSkillSources;
  // Keyed by Skill name. Changed only by code with no yield in between, so
  // two passes never both see a Skill as free.
  const running = new Map<string, RunningCheck>();

  /**
   * Stores an accepted tree on the Skill read in the write transaction, by
   * the result rules of spec 11:
   *
   * - the current revision's hash clears the available revision;
   * - another revision's hash makes that revision available, so an upstream
   *   revert reuses its row;
   * - any other hash is stored as a new `github` revision, made available.
   *
   * Then every `github` revision that was never applied and is not available
   * is deleted. Returns the deleted revisions' hashes.
   */
  const storeAcceptedTree = (
    stored: StoredSkill,
    content: CheckedSkillContent,
    at: string,
  ): Effect.Effect<ReadonlyArray<string>, SqlError> =>
    Effect.gen(function* () {
      const { id, skill } = stored;
      const change = { at, actor: SYSTEM_ACTOR };
      const hash = content.revisionHash;
      let available: string | null = null;
      if (hash !== skill.currentRevisionHash) {
        if (!(yield* skills.hasRevision(id, hash))) {
          yield* skills.insertRevision(id, {
            hash,
            origin: "github",
            fileCount: content.files.length,
            sizeBytes: content.sizeBytes,
            description: content.description,
            approvalEffects: content.approvalEffects,
            ...change,
          });
        }
        available = hash;
      }
      if (available !== skill.availableRevisionHash) {
        yield* skills.setAvailableRevision(id, available, change);
      }
      return yield* skills.deleteUnappliedGithubRevisions(id, available);
    });

  /**
   * Stores one Skill's result on the Skill as the write transaction read it,
   * and returns what to record of the check, or undefined when the result is
   * dropped. A result is dropped when another write changed the Skill in a
   * way the check did not see:
   *
   * - `Unchanged` when the upstream commit is no longer the one the pass
   *   read, as after an apply, so the shortcut no longer holds;
   * - `Accepted` when the Skill no longer has the revision whose archive was
   *   therefore not published.
   *
   * The next check repeats a dropped result. A check that checked no tree
   * clears the upstream commit, so the next check downloads the tree.
   */
  const storeResult = (
    stored: StoredSkill,
    outcome: CheckOutcome,
    at: string,
    stores: {
      readonly published: ReadonlySet<string>;
      readonly failures: ReadonlyMap<string, SkillFileError>;
      readonly releasedHashes: Array<string>;
    },
  ): Effect.Effect<SkillCheckRecord | undefined, SqlError> =>
    Effect.gen(function* () {
      switch (outcome._tag) {
        case "Unchanged":
          return stored.upstreamCommit === outcome.commit
            ? { at, checkError: stored.skill.checkError, upstreamCommit: outcome.commit }
            : undefined;
        case "Unreadable":
          return { at, checkError: buildCheckError([outcome.message]), upstreamCommit: null };
        case "Refused":
          return {
            at,
            checkError: buildCheckError(outcome.issues),
            upstreamCommit: outcome.commit,
          };
        case "Accepted": {
          const hash = outcome.content.revisionHash;
          if (stores.failures.has(hash)) {
            return { at, checkError: ARCHIVE_NOT_STORED_MESSAGE, upstreamCommit: null };
          }
          if (!stores.published.has(hash) && !(yield* skills.hasRevision(stored.id, hash))) {
            return undefined;
          }
          stores.releasedHashes.push(...(yield* storeAcceptedTree(stored, outcome.content, at)));
          return { at, checkError: null, upstreamCommit: outcome.commit };
        }
      }
    });

  /**
   * Writes the results of one group in one transaction, after publishing the
   * archive of each accepted tree whose revision the Skill does not hold yet.
   * An archive that cannot be written becomes its Skill's check error, and
   * the other results are still stored. A failed write is logged; the next
   * check tries again.
   */
  const storeResults = (repo: string, results: ReadonlyArray<CheckResult>): Effect.Effect<void> =>
    Effect.gen(function* () {
      const contents: Array<CheckedSkillContent> = [];
      for (const { checked, outcome } of results) {
        if (
          outcome._tag === "Accepted" &&
          !(yield* skills.hasRevision(checked.stored.id, outcome.content.revisionHash))
        ) {
          contents.push(outcome.content);
        }
      }
      yield* files.publishAll(contents, (failures) =>
        Effect.gen(function* () {
          for (const [hash, error] of failures) {
            yield* Effect.logError(
              `Writing the archive of the Skill Revision ${hash}, which an update check of \`${repo}\` found, failed`,
              error,
            );
          }
          const published = new Set(
            contents.map((content) => content.revisionHash).filter((hash) => !failures.has(hash)),
          );
          return yield* withTransaction(
            sql,
            Effect.gen(function* () {
              const fresh = new Map(
                (yield* skills.listByNames(
                  results.map(({ checked }) => checked.stored.skill.name),
                )).map((stored) => [stored.skill.name, stored]),
              );
              const at = yield* nowIso;
              // Every published archive is released: the cleanup keeps each one a row names.
              const releasedHashes = [...published];
              for (const { checked, outcome } of results) {
                const stored = fresh.get(checked.stored.skill.name);
                if (stored === undefined || !isSameSource(stored.skill.source, checked.source)) {
                  continue;
                }
                const record = yield* storeResult(stored, outcome, at, {
                  published,
                  failures,
                  releasedHashes,
                });
                if (record === undefined) continue;
                yield* skills.recordCheck(stored.id, record);
                yield* announce({
                  _tag: "record",
                  topic: "skill",
                  id: stored.skill.name,
                  kind: "updated",
                });
              }
              return { answer: undefined, releasedHashes };
            }),
          );
        }),
      );
    }).pipe(
      Effect.catch((error) =>
        Effect.logError(
          `Storing the update check of the skills from \`${repo}\` failed; the next check tries again`,
          error,
        ),
      ),
    );

  /** Checks one Skill's folder from the downloaded tree with the content rules. */
  const checkFetchedTree = (
    checked: GithubSkill,
    tree: DownloadedSkillTree | undefined,
    commit: string,
  ): Effect.Effect<CheckOutcome> => {
    // The download returns a tree for every path it was given.
    if (tree === undefined) {
      return Effect.die(`the download returned no tree for \`${checked.source.path}\``);
    }
    if (tree._tag === "Refused") {
      return Effect.succeed({ _tag: "Refused", issues: [tree.reason], commit });
    }
    return Effect.match(checkSkillContent(checked.stored.skill.name, tree.entries), {
      onFailure: (refused): CheckOutcome => ({ _tag: "Refused", issues: refused.issues, commit }),
      onSuccess: (content): CheckOutcome => ({ _tag: "Accepted", content, commit }),
    });
  };

  /** Returns `message` as the result of every Skill in `group`, after logging it. */
  const markUnreadable = (
    repo: string,
    group: ReadonlyArray<GithubSkill>,
    message: string,
  ): Effect.Effect<ReadonlyArray<CheckResult>> =>
    Effect.as(
      Effect.logWarning(`The update check could not read \`${repo}\` on GitHub: ${message}`),
      group.map((checked) => ({ checked, outcome: { _tag: "Unreadable", message } as const })),
    );

  /** Checks the Skills of one repository and branch against GitHub, reading it at most twice. */
  const readGroupResults = (group: RepositoryGroup): Effect.Effect<ReadonlyArray<CheckResult>> =>
    Effect.matchEffect(github.readUpstreamCommit(group.repo, group.branch), {
      onFailure: (error) => markUnreadable(group.repo, group.skills, error.message),
      onSuccess: (commit) =>
        Effect.gen(function* () {
          const results: Array<CheckResult> = [];
          const changed: Array<GithubSkill> = [];
          for (const checked of group.skills) {
            if (checked.stored.upstreamCommit === commit) {
              results.push({ checked, outcome: { _tag: "Unchanged", commit } });
            } else changed.push(checked);
          }
          if (changed.length === 0) return results;
          const paths = [...new Set(changed.map((checked) => checked.source.path))];
          const downloaded = yield* Effect.result(
            github.downloadSkillTrees(group.repo, commit, paths),
          );
          if (Result.isFailure(downloaded)) {
            return [
              ...results,
              ...(yield* markUnreadable(group.repo, changed, downloaded.failure.message)),
            ];
          }
          for (const checked of changed) {
            const tree = downloaded.success.get(checked.source.path);
            results.push({ checked, outcome: yield* checkFetchedTree(checked, tree, commit) });
          }
          return results;
        }),
    });

  /** Checks the Skills of one repository and branch, and stores their results in one transaction. */
  const checkGroup = (group: RepositoryGroup): Effect.Effect<void> =>
    Effect.flatMap(readGroupResults(group), (results) => storeResults(group.repo, results));

  /**
   * Claims each GitHub Skill that has no check running, grouped by repository
   * and branch, and returns the groups and the Skills whose check runs.
   * Synchronous, so no other pass claims a Skill in between.
   */
  const claimChecks = (candidates: ReadonlyArray<StoredSkill>) => {
    const groups = new Map<string, RepositoryGroup>();
    const busy: Array<{ readonly checked: GithubSkill; readonly check: RunningCheck }> = [];
    for (const stored of candidates) {
      const source = stored.skill.source;
      if (source.kind !== "github") continue;
      const checked = { stored, source };
      const check = running.get(stored.skill.name);
      if (check !== undefined) {
        busy.push({ checked, check });
        continue;
      }
      const key = JSON.stringify([source.repo, source.branch]);
      let group = groups.get(key);
      if (group === undefined) {
        group = {
          repo: source.repo,
          branch: source.branch,
          skills: [],
          ended: Deferred.makeUnsafe<void>(),
        };
        groups.set(key, group);
      }
      group.skills.push(checked);
      running.set(stored.skill.name, { source, ended: group.ended });
    }
    return { groups: [...groups.values()], busy };
  };

  /** Ends the checks of a group: frees its Skills and wakes every pass waiting on them. */
  const releaseGroup = (group: RepositoryGroup): Effect.Effect<void> =>
    Effect.suspend(() => {
      for (const checked of group.skills) {
        const name = checked.stored.skill.name;
        if (running.get(name)?.ended === group.ended) running.delete(name);
      }
      return Deferred.succeed(group.ended, undefined);
    });

  /**
   * Checks each Skill with a GitHub source among `candidates`, and returns
   * once every one of those checks has ended. Skills with an `upload` source
   * are skipped. Never fails: a check's failure is its Skill's `checkError`,
   * and a failed write is logged.
   */
  const checkSkills = (candidates: ReadonlyArray<StoredSkill>): Effect.Effect<void> =>
    Effect.uninterruptibleMask((restore) =>
      Effect.flatMap(
        Effect.sync(() => claimChecks(candidates)),
        ({ groups, busy }) =>
          restore(
            Effect.all(
              [
                Effect.forEach(
                  groups,
                  (group) => Effect.ensuring(checkGroup(group), releaseGroup(group)),
                  { concurrency: MAX_CONCURRENT_REPOSITORIES, discard: true },
                ),
                Effect.forEach(busy, ({ checked, check }) => joinCheck(checked, check), {
                  concurrency: "unbounded",
                  discard: true,
                }),
              ],
              { concurrency: "unbounded", discard: true },
            ),
          ).pipe(
            // A group that never started, because the pass was interrupted,
            // is released here.
            Effect.ensuring(Effect.forEach(groups, releaseGroup, { discard: true })),
          ),
      ),
    );

  /**
   * Waits for the running check of a Skill to end. When that check began with
   * the source this pass read, its result is this pass's too. Otherwise its
   * result is dropped, so the Skill is read again and checked once more.
   */
  const joinCheck = (checked: GithubSkill, check: RunningCheck): Effect.Effect<void> =>
    Effect.andThen(
      Deferred.await(check.ended),
      isSameSource(check.source, checked.source)
        ? Effect.void
        : skills.findByName(checked.stored.skill.name).pipe(
            Effect.flatMap(
              Option.match({
                onNone: () => Effect.void,
                onSome: (stored) => checkSkills([stored]),
              }),
            ),
            Effect.catch((error) =>
              Effect.logError(
                `Reading the skill \`${checked.stored.skill.name}\` for its update check failed`,
                error,
              ),
            ),
          ),
    );

  return { checkSkills };
});
