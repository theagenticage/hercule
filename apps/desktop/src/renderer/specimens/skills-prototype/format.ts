/**
 * PROTOTYPE (#731). The few texts the Skills screens build from a skill:
 * its source line, its size, who applied a revision, and its `SKILL.md`
 * split into frontmatter and body. In the build these are client-core
 * functions with tests of their own.
 */
import type { Applier, RevisionKind, SkillSource } from "./fixture";

/** Returns the line under a skill's name that says where it comes from: "GitHub: <repo>" or "Uploaded". */
export const describeSource = (source: SkillSource): string =>
  source.kind === "github" ? `GitHub: ${source.repo}` : "Uploaded";

/**
 * Returns `bytes` as people read a file size: "N bytes" under 1000, then
 * kilobytes of 1000 bytes, then megabytes of a million, to one decimal.
 * Finder counts in the same units, so a size here matches the folder the
 * user imported.
 */
export const formatBytes = (bytes: number): string => {
  if (bytes < 1000) return `${bytes} bytes`;
  if (bytes < 1_000_000) return `${(bytes / 1000).toFixed(1)} KB`;
  return `${(bytes / 1_000_000).toFixed(1)} MB`;
};

/** Returns "N file(s) · <size>" for a skill's file count and total size. */
export const describeFiles = (fileCount: number, totalBytes: number): string =>
  `${fileCount} ${fileCount === 1 ? "file" : "files"} · ${formatBytes(totalBytes)}`;

/** Returns the label History gives a revision of kind `kind`. */
export const describeRevisionKind = (kind: RevisionKind): string =>
  ({
    imported: "Imported",
    updated: "Updated from GitHub",
    proposed: "Proposed by a session",
  })[kind];

/** Returns who applied a revision as History writes it: "you", or "Ada, session s_12". */
export const describeApplier = (applier: Applier): string =>
  applier === "you" ? "you" : `${applier.assistant}, session ${applier.session}`;

/** One `key: value` line of a `SKILL.md`'s frontmatter. */
export interface FrontmatterField {
  readonly key: string;
  readonly value: string;
}

/**
 * Splits a `SKILL.md` into its frontmatter fields and its markdown body. A
 * file with no frontmatter returns no fields and the whole text as the
 * body. Values are read as written, without YAML's quotes, which is enough
 * for the one-line fields a skill's frontmatter holds.
 */
export const splitSkillMd = (
  text: string,
): { readonly fields: ReadonlyArray<FrontmatterField>; readonly body: string } => {
  const match = /^---\n([\s\S]*?)\n---\n?/.exec(text);
  if (match === null) return { fields: [], body: text };
  const fields = match[1]!.split("\n").flatMap((line): Array<FrontmatterField> => {
    const at = line.indexOf(":");
    if (at <= 0) return [];
    const value = line
      .slice(at + 1)
      .trim()
      .replace(/^"(.*)"$/, "$1");
    return [{ key: line.slice(0, at).trim(), value }];
  });
  return { fields, body: text.slice(match[0].length) };
};

/**
 * Splits an `allowed-tools` value into its tools. The tools are separated
 * by spaces, but a tool's pattern in parentheses may hold spaces of its
 * own, as `Bash(git tag:*)` does, so a space inside parentheses does not
 * split.
 */
export const splitAllowedTools = (value: string): ReadonlyArray<string> =>
  value.match(/[^\s(]+\([^)]*\)|\S+/g) ?? [];
