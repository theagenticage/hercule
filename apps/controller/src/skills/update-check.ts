/**
 * The update check of Skills with a GitHub source (spec 11 §2 `skill.check`,
 * spec 04 "Skill rows").
 *
 * A check pass groups its Skills by repository and branch. Each group reads
 * the branch's commit once. A Skill whose last judged commit is that commit
 * downloads nothing. The repository is downloaded once for the rest of the
 * group, and each Skill's folder is checked with the content rules.
 *
 * One check runs at a time per Skill. A pass that finds a Skill's check
 * running waits for it to end. When the running check began with the same
 * source, the pass takes its result as its own. Otherwise the running check's
 * result is dropped, so the pass then checks the Skill again.
 *
 * Each Skill's result is written by its own transaction, which reads the
 * Skill again and drops the result when the source changed since the check
 * began. A check runs with no actor: what it stores is stamped `system`.
 */
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
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
 * - `Unchanged`: the branch is still at the commit the last check judged.
 * - `Unreadable`: GitHub could not be read, so no tree was judged.
 * - `Refused`: the tree at `commit` cannot become a revision; `message` says why.
 * - `Fetched`: the tree at `commit` passed the content rules.
 */
type CheckOutcome =
  | { readonly _tag: "Unchanged" }
  | { readonly _tag: "Unreadable"; readonly message: string }
  | { readonly _tag: "Refused"; readonly message: string; readonly commit: string }
  | { readonly _tag: "Fetched"; readonly content: CheckedSkillContent; readonly commit: string };

/**
 * Returns what a finished check records on the Skill. A check that judged no
 * tree clears the upstream commit, so the next check downloads the tree
 * rather than keep an error about a tree nobody judged.
 */
const buildCheckRecord = (
  outcome: CheckOutcome,
  stored: StoredSkill,
  at: string,
): SkillCheckRecord => {
  switch (outcome._tag) {
    case "Unchanged":
      return { at, checkError: stored.skill.checkError, upstreamCommit: stored.upstreamCommit };
    case "Unreadable":
      return { at, checkError: outcome.message, upstreamCommit: null };
    case "Refused":
      return { at, checkError: outcome.message, upstreamCommit: outcome.commit };
    case "Fetched":
      return { at, checkError: null, upstreamCommit: outcome.commit };
  }
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
   * Stores the result of a fetched tree on the Skill read in the write
   * transaction, by the result rules of spec 11:
   *
   * - the current revision's hash clears the available revision;
   * - another revision's hash makes that revision available, so an upstream
   *   revert reuses its row;
   * - any other hash is stored as a new `github` revision, made available.
   *
   * Then every `github` revision that was never applied and is not available
   * is deleted. Returns the hashes whose archives may have no row left.
   */
  const storeFetchedTree = (
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
      const deleted = yield* skills.deleteUnappliedGithubRevisions(id, available);
      // The archive of `hash` was published before this transaction. When the
      // transaction stored no row for it, the cleanup removes it.
      return [...deleted, hash];
    });

  /**
   * Writes how a Skill's check ended, in one transaction that drops the
   * result when the Skill is gone or its source changed since the check
   * began. A failed write is logged; the next check tries again.
   */
  const storeOutcome = (checked: GithubSkill, outcome: CheckOutcome): Effect.Effect<void> => {
    const { name } = checked.stored.skill;
    const store = Effect.gen(function* () {
      const found = yield* skills.findByName(name);
      if (Option.isNone(found) || !isSameSource(found.value.skill.source, checked.source)) {
        const releasedHashes = outcome._tag === "Fetched" ? [outcome.content.revisionHash] : [];
        return { answer: undefined, releasedHashes };
      }
      const at = yield* nowIso;
      const releasedHashes =
        outcome._tag === "Fetched" ? yield* storeFetchedTree(found.value, outcome.content, at) : [];
      yield* skills.recordCheck(found.value.id, buildCheckRecord(outcome, found.value, at));
      yield* announce({ _tag: "record", topic: "skill", id: name, kind: "updated" });
      return { answer: undefined, releasedHashes };
    });
    const write: Effect.Effect<void, SqlError | SkillFileError> =
      outcome._tag === "Fetched"
        ? files.publish(outcome.content, withTransaction(sql, store))
        : Effect.asVoid(withTransaction(sql, store));
    return write.pipe(
      Effect.catch((error) =>
        Effect.logError(
          `Storing the update check of the skill \`${name}\` failed; the next check tries again`,
          error,
        ),
      ),
    );
  };

  /** Judges one Skill's folder from the downloaded tree with the content rules. */
  const judgeTree = (
    checked: GithubSkill,
    tree: DownloadedSkillTree | undefined,
    commit: string,
  ): Effect.Effect<CheckOutcome> => {
    // The download returns a tree for every path it was given.
    if (tree === undefined) {
      return Effect.die(`the download returned no tree for \`${checked.source.path}\``);
    }
    if (tree._tag === "Refused") {
      return Effect.succeed({ _tag: "Refused", message: tree.reason, commit });
    }
    return Effect.match(checkSkillContent(checked.stored.skill.name, tree.entries), {
      onFailure: (refused): CheckOutcome => ({
        _tag: "Refused",
        message: refused.issues.join(" "),
        commit,
      }),
      onSuccess: (content): CheckOutcome => ({ _tag: "Fetched", content, commit }),
    });
  };

  /** Records `message` as the check error of every Skill in `group`, after logging it. */
  const storeUnreadable = (
    repo: string,
    group: ReadonlyArray<GithubSkill>,
    message: string,
  ): Effect.Effect<void> =>
    Effect.andThen(
      Effect.logWarning(`The update check could not read \`${repo}\` on GitHub: ${message}`),
      Effect.forEach(group, (checked) => storeOutcome(checked, { _tag: "Unreadable", message }), {
        discard: true,
      }),
    );

  /** Checks the Skills of one repository and branch, reading GitHub at most twice. */
  const checkGroup = (group: RepositoryGroup): Effect.Effect<void> =>
    Effect.matchEffect(github.readUpstreamCommit(group.repo, group.branch), {
      onFailure: (error) => storeUnreadable(group.repo, group.skills, error.message),
      onSuccess: (commit) =>
        Effect.gen(function* () {
          const unchanged = group.skills.filter(
            (checked) => checked.stored.upstreamCommit === commit,
          );
          const changed = group.skills.filter(
            (checked) => checked.stored.upstreamCommit !== commit,
          );
          yield* Effect.forEach(
            unchanged,
            (checked) => storeOutcome(checked, { _tag: "Unchanged" }),
            { discard: true },
          );
          if (changed.length === 0) return;
          const paths = [...new Set(changed.map((checked) => checked.source.path))];
          yield* Effect.matchEffect(github.downloadSkillTrees(group.repo, commit, paths), {
            onFailure: (error) => storeUnreadable(group.repo, changed, error.message),
            onSuccess: (trees) =>
              Effect.forEach(
                changed,
                (checked) =>
                  Effect.flatMap(
                    judgeTree(checked, trees.get(checked.source.path), commit),
                    (outcome) => storeOutcome(checked, outcome),
                  ),
                { discard: true },
              ),
          });
        }),
    });

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
