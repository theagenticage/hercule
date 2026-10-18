/**
 * What the Skill Library's screens and the CLI need to interpret about a
 * Skill: where it comes from, its size, the warning lines for frontmatter
 * that changes approvals, the `SKILL.md` a page draws, its History lines, and
 * the lines an import or an upload shows.
 */
import {
  formatIssue,
  MAX_SKILL_BYTES,
  type SkillApprovalEffects,
  type NullableActor,
  type SkillDetail,
  type SkillFileRecord,
  type SkillImportInput,
  type SkillRevision,
  type SkillRevisionOrigin,
  type SkillSource,
} from "@hercule/contract";
import { describeActor } from "./actor-display";
import type { HerculeClient } from "./client";
import { ApiError, isConflict, readErrorMessage, readValidationIssues } from "./errors";
import { formatBytes } from "./format-bytes";
import { formatShortMoment } from "./time-context";

/** The start of the warning line for a skill whose `SKILL.md` has `allowed-tools`. */
export const SKILL_ALLOWED_TOOLS_WARNING = "Lets tools run without asking:";

/** The warning line for a skill whose `SKILL.md` has `hooks`. */
export const SKILL_HOOKS_WARNING = "Has hooks, which run without asking";

/**
 * Returns the CLI's warning lines for skill `name`, whose current revision
 * has the approval effects `effects`, one per field that is set (spec 11
 * §2, `skill`):
 *
 * - `allowedTools`: "`grilling` lets tools run without asking: `Bash(git:*)`",
 *   with the whole value as one code span.
 * - `hooks`: "`grilling` has hooks, which run without asking".
 *
 * Returns no lines for null effects or effects with neither field. On Claude
 * Code either field can let tools run without Hercule's approval card, so the
 * user should see it (spec 13 §8). The code spans are between backticks.
 */
export const listSkillApprovalWarnings = (
  name: string,
  effects: SkillApprovalEffects | null,
): ReadonlyArray<string> => {
  if (effects === null) return [];
  const lines: Array<string> = [];
  if (effects.allowedTools !== null)
    lines.push(
      `\`${name}\` ${lowercaseFirstLetter(SKILL_ALLOWED_TOOLS_WARNING)} \`${effects.allowedTools}\``,
    );
  if (effects.hooks !== null)
    lines.push(`\`${name}\` ${lowercaseFirstLetter(SKILL_HOOKS_WARNING)}`);
  return lines;
};

/** Returns `text` with its first letter lowercase, so a warning line can follow a skill's name. */
const lowercaseFirstLetter = (text: string): string => text.charAt(0).toLowerCase() + text.slice(1);

/**
 * Splits an `allowed-tools` value into its rules, so a screen can draw each as
 * code. The rules are separated by spaces, but a rule's pattern in
 * parentheses may hold spaces of its own, as `Bash(git tag:*)` does, so a
 * space inside parentheses does not split.
 */
export const splitAllowedTools = (allowedTools: string): ReadonlyArray<string> =>
  allowedTools.match(/[^\s(]+\([^)]*\)|\S+/g) ?? [];

/**
 * The GitHub source a `.skill-lock.json` gives a skill folder: its repository,
 * such as `mattpocock/skills`, and the skill's folder in it, "" at the
 * repository's root.
 */
export interface LockedSkillSource {
  readonly repo: string;
  readonly path: string;
}

/** Formats a skill's file count and total bytes as "2 files · 6.5 KiB", or "1 file · 812 B". */
export const formatSkillSize = (fileCount: number, sizeBytes: number): string =>
  `${String(fileCount)} ${fileCount === 1 ? "file" : "files"} · ${formatBytes(sizeBytes)}`;

/**
 * Returns where a skill comes from, as the line under its name reads:
 * "GitHub: mattpocock/skills" for a GitHub source, or "Uploaded".
 */
export const describeSkillSource = (source: SkillSource): string =>
  source.kind === "github" ? `GitHub: ${source.repo}` : "Uploaded";

/**
 * Returns where a skill folder comes from, as its row in the import dialog
 * reads, worded as `describeSkillSource` words a stored skill's source:
 * "GitHub: mattpocock/skills" for the GitHub source `source` a lock file
 * gives, or "Uploaded" for none.
 */
export const describeLockedSkillSource = (source: LockedSkillSource | null): string =>
  describeSkillSource(
    source === null ? { kind: "upload" } : { kind: "github", ...source, branch: null },
  );

/**
 * Returns where a skill comes from, as the source chip on its page reads:
 * "mattpocock/skills · skills/grilling" for a GitHub source, with
 * " · branch next" after it when the source reads a branch other than the
 * repository's default one, or "Uploaded".
 */
export const describeSkillSourceInFull = (source: SkillSource): string => {
  if (source.kind === "upload") return "Uploaded";
  const location = `${source.repo} · ${source.path}`;
  return source.branch === null ? location : `${location} · branch ${source.branch}`;
};

/**
 * Returns a `SKILL.md` without its frontmatter: the lines from an opening
 * `---` on the first line to the next `---` line, both included. The lines
 * are dropped without being parsed, because a page shows the `description`
 * the controller read from them. Returns the text unchanged when its first
 * line is not `---`, or when no line closes the frontmatter.
 *
 * A byte order mark before the opening `---` is allowed, because the
 * controller's content rules allow it.
 */
export const stripFrontmatter = (skillMd: string): string => {
  const lines = skillMd.split("\n");
  if (lines[0]?.replace(/^\uFEFF/, "").trimEnd() !== "---") return skillMd;
  const closing = lines.findIndex((line, at) => at > 0 && line.trimEnd() === "---");
  return closing === -1 ? skillMd : lines.slice(closing + 1).join("\n");
};

const ORIGIN_LABELS: Readonly<Record<SkillRevisionOrigin, string>> = {
  import: "Imported",
  github: "Updated from GitHub",
  session: "Proposed by a session",
};

/** Returns how a Skill Revision arrived, as its History row names it: "Imported", "Updated from GitHub" or "Proposed by a session". */
export const describeSkillRevisionOrigin = (origin: SkillRevisionOrigin): string =>
  ORIGIN_LABELS[origin];

/**
 * Returns who applied a Skill Revision and when, as the line under its
 * History row reads: "applied by you, 14:02". The time is relative to `now`
 * in `timezone`, as `formatShortMoment` writes it ("Mon 09:00", "4 Nov
 * 09:00"). A part that is not known is left out: "applied by you" when the
 * time cannot be placed.
 */
export const describeSkillRevisionApplied = (
  revision: { readonly appliedAt: string | null; readonly appliedBy: NullableActor },
  now: Date,
  timezone: string,
): string => {
  const by =
    revision.appliedBy === null
      ? "applied"
      : `applied by ${describeActor(revision.appliedBy).label}`;
  const at =
    revision.appliedAt === null
      ? undefined
      : formatShortMoment(new Date(revision.appliedAt), now, timezone);
  return at === undefined ? by : `${by}, ${at}`;
};

/**
 * Returns the line for a skill whose archive is over `MAX_SKILL_BYTES`:
 * "`teach` is over 10 MiB, the most a skill can hold." The name is a code
 * span, between backticks.
 */
export const describeSkillTooLarge = (name: string): string =>
  `\`${name}\` is over ${formatBytes(MAX_SKILL_BYTES)}, the most a skill can hold.`;

/**
 * Returns the line for a picked folder that holds no skill: "No skills in
 * `~/notes`. A skill is a folder that holds a `SKILL.md`."
 */
export const describeFolderWithoutSkills = (displayPath: string): string =>
  `No skills in \`${displayPath}\`. A skill is a folder that holds a \`SKILL.md\`.`;

/**
 * Returns why a picked folder cannot be uploaded as a new version of skill
 * `name`, or null when it can: it must hold exactly one skill, and that skill
 * must be named `name`.
 *
 * - No skill: "No skills in `~/notes`. ..." (`describeFolderWithoutSkills`).
 * - Another skill: "The folder holds `teaching`, not `teach`."
 * - Several: "The folder holds 3 skills, not `teach`.", also when `name` is
 *   one of them, because an upload sends one skill.
 */
export const describeUploadFolderProblem = (
  name: string,
  folder: { readonly displayPath: string; readonly skillNames: ReadonlyArray<string> },
): string | null => {
  const [only, ...others] = folder.skillNames;
  if (only === undefined) return describeFolderWithoutSkills(folder.displayPath);
  if (others.length > 0)
    return `The folder holds ${String(folder.skillNames.length)} skills, not \`${name}\`.`;
  return only === name ? null : `The folder holds \`${only}\`, not \`${name}\`.`;
};

/**
 * What became of one skill of an import from a folder:
 *
 * - `imported`: the controller created it, or made its content the current
 *   revision.
 * - `unchanged`: its content was already the current revision.
 * - `conflict`: it exists with different content, and waits for the user to
 *   confirm or skip it.
 * - `skipped`: it existed with different content, and the user chose Skip.
 * - `refused`: the folder reader or the controller refused it, for `reason`,
 *   whose code spans are between backticks.
 */
export type SkillImportOutcome =
  | { readonly kind: "imported" | "unchanged" | "conflict" | "skipped" }
  | { readonly kind: "refused"; readonly reason: string };

/**
 * Returns why the controller refused to import a skill, worded as the
 * controller words it. A refused content rule is a `validation` error whose
 * issues each say what was wrong and what to do, so the issues are joined
 * into the reason. Any other error gives its message.
 */
const describeSkillImportRefusal = (error: unknown): string => {
  const issues = readValidationIssues(error) ?? [];
  return issues.length === 0 ? readErrorMessage(error) : issues.map(formatIssue).join(" ");
};

/**
 * Returns the query of the `skill.import` that sends `skill`: its name, and
 * its GitHub source when the lock file gives it one. A skill with no source
 * gets none, so the controller stores an `upload` source. `replace: true` is
 * added only when `replace` is true, so a caller may spread the query over a
 * `replace` of its own.
 */
export const buildSkillImportQuery = (
  skill: { readonly name: string; readonly source: LockedSkillSource | null },
  replace: boolean,
): SkillImportInput => ({
  name: skill.name,
  ...(replace ? { replace: true } : {}),
  ...(skill.source === null
    ? {}
    : { sourceRepo: skill.source.repo, sourcePath: skill.source.path }),
});

/** The error codes that answer for the credential rather than one skill. */
const CREDENTIAL_ERROR_CODES: ReadonlySet<string> = new Set(["forbidden", "unauthenticated"]);

/**
 * Checks whether `error`, from one `skill.import` of a folder import, is the
 * controller refusing that one skill, so the import goes on with the next
 * skill. Returns false, and the import stops at that skill, for:
 *
 * - `forbidden` or `unauthenticated`: the answer is about the credential, not
 *   the skill, so every later skill would get it too.
 * - An `ApiError` with a `cause`: the client made it from a response that was
 *   not the controller's error envelope (`toClientError`), such as a proxy's
 *   HTML error page. Nothing in that response says what became of the skill:
 *   the controller may never have seen it, or may have stored it. And the
 *   next skill would most likely get the same response.
 * - Any error that is not an `ApiError`, such as a controller that cannot be
 *   reached any more.
 */
export const isSkillImportRefusal = (error: unknown): error is ApiError =>
  error instanceof ApiError && error.cause === undefined && !CREDENTIAL_ERROR_CODES.has(error.code);

/**
 * Sends one skill's tar archive `archive` with `skill.import` and the query
 * `query` (`buildSkillImportQuery`), and returns what became of the skill. A
 * `conflict` error is not a refusal: the skill exists with different
 * content, and the user decides whether it replaces the current revision.
 *
 * Rejects with the error when it is not a refusal of this one skill
 * (`isSkillImportRefusal`), so the caller stops the import there.
 */
export const importSkillArchive = async (
  client: HerculeClient,
  query: SkillImportInput,
  archive: Uint8Array,
): Promise<SkillImportOutcome> => {
  try {
    const { result } = await client.skill.import({ query, payload: archive });
    return { kind: result === "unchanged" ? "unchanged" : "imported" };
  } catch (error) {
    if (!isSkillImportRefusal(error)) throw error;
    return isConflict(error)
      ? { kind: "conflict" }
      : { kind: "refused", reason: describeSkillImportRefusal(error) };
  }
};

/**
 * Counts `outcomes` for the import's summary. A conflict nobody confirmed is
 * counted as skipped, because the skill is left as it was, as Skip leaves it.
 */
export const countSkillImportOutcomes = (
  outcomes: Iterable<SkillImportOutcome>,
): SkillImportCounts => {
  const counts = { imported: 0, unchanged: 0, refused: 0, skipped: 0 };
  for (const { kind } of outcomes) counts[kind === "conflict" ? "skipped" : kind] += 1;
  return counts;
};

/** How the skills of one import from a folder ended. */
export interface SkillImportCounts {
  /** Created, or made a new current revision, also after a confirmed conflict. */
  readonly imported: number;
  /** Their content was already the current revision. */
  readonly unchanged: number;
  /** Refused by the folder reader or by the controller. */
  readonly refused: number;
  /** Existed with different content, and the user chose Skip. */
  readonly skipped: number;
}

/**
 * Returns the summary at the end of an import: "Imported 21, 2 unchanged,
 * 1 refused". The skills the user chose to skip are counted at the end, ",
 * 2 skipped", only when there are some, so the parts always add up to the
 * skills that ran.
 */
export const describeSkillImportSummary = (counts: SkillImportCounts): string => {
  const summary = `Imported ${String(counts.imported)}, ${String(counts.unchanged)} unchanged, ${String(counts.refused)} refused`;
  return counts.skipped === 0 ? summary : `${summary}, ${String(counts.skipped)} skipped`;
};

/**
 * Returns the revision of `detail` that is its skill's current revision, from
 * its history, or `undefined` when the skill has no current revision. The
 * page's lead shows its `description`.
 */
export const findCurrentSkillRevision = (detail: SkillDetail): SkillRevision | undefined =>
  detail.history.find(({ revisionHash }) => revisionHash === detail.skill.currentRevisionHash);

/** Returns the size in bytes of the `SKILL.md` among `files`, or 0 when there is none. */
export const findSkillMdSize = (files: ReadonlyArray<SkillFileRecord>): number =>
  files.find(({ path }) => path === "SKILL.md")?.sizeBytes ?? 0;

/** Checks whether `file` is executable: its mode is `755`, the only executable mode a skill keeps. */
export const isExecutableSkillFile = (file: SkillFileRecord): boolean => file.mode === "755";
