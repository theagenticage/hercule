/**
 * PROTOTYPE (#731). The few texts the Skills screens build from a skill:
 * its source line, its size, who applied a revision, and its `SKILL.md`
 * split into frontmatter and body. In the build these are client-core
 * functions with tests of their own. Sizes use client-core's `formatBytes`,
 * the one unit system the app shows sizes in.
 */
import { formatBytes } from "@hercule/client-core";
import type { Applier, RevisionKind, SkillSource } from "./fixture";

/** Returns the line under a skill's name that says where it comes from: "GitHub: <repo>" or "Uploaded". */
export const describeSource = (source: SkillSource): string =>
  source.kind === "github" ? `GitHub: ${source.repo}` : "Uploaded";

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

/**
 * Returns `markdown` with each link to a relative address replaced by its
 * text. A `SKILL.md` links the skill's other files, such as
 * `references/labels.md`, and the page shows none of them, so such a link
 * would go nowhere. Links to `http` and `https` addresses stay links.
 */
export const unlinkRelativeLinks = (markdown: string): string =>
  markdown.replace(/(?<!!)\[([^\]]+)\]\((?!https?:\/\/)[^)]*\)/g, "$1");
