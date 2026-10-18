/**
 * The file changes `skill.diff` returns: how each file of a Skill Revision
 * differs from the same path in the Skill's current revision, with a unified
 * diff the user reads before applying the revision.
 */
import { formatPatch, OMIT_HEADERS, structuredPatch } from "diff";
import type { SkillFileChange } from "@hercule/contract";
import { compareSkillPaths, type SkillFile } from "@hercule/protocol";

/** The largest side of a file, and the largest total of all patches, that a diff shows: 1 MiB. */
const MAX_PATCH_BYTES = 1024 * 1024;

/** The lines of unchanged text shown around each change, as `diff -u` shows. */
const CONTEXT_LINES = 3;

/**
 * The most lines a diff of one file may add and remove before it gives up.
 * jsdiff's time grows with the square of this number: at 1000 the worst case,
 * two 1 MiB files with nothing in common, takes about 100 ms. A file with
 * more changes than this gets one hunk that removes every old line and adds
 * every new line. A modified line counts twice: once removed, once added.
 */
const MAX_EDIT_LINES = 1000;

/**
 * The most lines the diffs of all files of one revision may add and remove
 * together. Without it, a revision of 1,000 files that each change 500 lines
 * keeps the controller busy for over 20 seconds; with it, one `skill.diff`
 * costs at most four files' worst case. A file diffed once this budget is
 * spent gets the one hunk of a file whose diff gave up.
 */
const MAX_TOTAL_EDIT_LINES = 4 * MAX_EDIT_LINES;

const utf8Encoder = new TextEncoder();

// `fatal` makes invalid UTF-8 an error instead of U+FFFD. `ignoreBOM` keeps a
// byte order mark in the text, so two files that differ only by one still
// show a difference.
const utf8Decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

type PatchOmitted = NonNullable<SkillFileChange["patchOmitted"]>;

/**
 * Returns one `SkillFileChange` per path that differs between `current` and
 * `revision`, sorted with `compareSkillPaths`. `current` is null when the
 * Skill has no current revision; then every file of `revision` is `added`.
 * A file with the same content and mode on both sides is left out.
 *
 * A patch is left out, with the reason in `patchOmitted`, when:
 *
 * - either side is over 1 MiB (`tooLarge`); sizes are checked before the
 *   content is decoded, so a large file is never decoded;
 * - either side holds a NUL byte or is not valid UTF-8 (`binary`);
 * - the patch would bring the patches given before it, in path order, past
 *   1 MiB in total (`tooLarge`). A file whose patch cannot fit, because its
 *   sides differ in size by more than what is left, is not diffed at all.
 *
 * The work is bounded for the whole revision, not only per file: the diffs
 * of all files share one budget of lines added and removed. A file diffed
 * once the budget is spent gets one hunk that replaces every line.
 */
export const computeSkillFileChanges = (
  current: ReadonlyArray<SkillFile> | null,
  revision: ReadonlyArray<SkillFile>,
): ReadonlyArray<SkillFileChange> => {
  const currentByPath = new Map((current ?? []).map((file) => [file.path, file]));
  const revisionByPath = new Map(revision.map((file) => [file.path, file]));
  const paths = [...new Set([...currentByPath.keys(), ...revisionByPath.keys()])].sort(
    compareSkillPaths,
  );

  const changes: Array<SkillFileChange> = [];
  const budget: DiffBudget = { patchBytes: MAX_PATCH_BYTES, editLines: MAX_TOTAL_EDIT_LINES };
  for (const path of paths) {
    const before = currentByPath.get(path);
    const after = revisionByPath.get(path);
    const sameContent =
      before !== undefined && after !== undefined && areBytesEqual(before.content, after.content);
    if (sameContent && before.mode === after.mode) continue;

    const change: SkillFileChange["change"] =
      before === undefined
        ? "added"
        : after === undefined
          ? "removed"
          : sameContent
            ? "modeChanged"
            : "modified";
    const mode = after?.mode ?? null;
    if (sameContent) {
      changes.push({ path, change, mode, patch: "", patchOmitted: null });
      continue;
    }

    const patch = buildPatch(before?.content, after?.content, budget);
    if (typeof patch !== "string") {
      changes.push({ path, change, mode, patch: null, patchOmitted: patch.omitted });
      continue;
    }
    const patchBytes = utf8Encoder.encode(patch).length;
    if (patchBytes > budget.patchBytes) {
      changes.push({ path, change, mode, patch: null, patchOmitted: "tooLarge" });
      continue;
    }
    budget.patchBytes -= patchBytes;
    changes.push({ path, change, mode, patch, patchOmitted: null });
  }
  return changes;
};

/** Checks whether two byte arrays hold the same bytes. */
const areBytesEqual = (left: Uint8Array, right: Uint8Array): boolean => {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index++) {
    if (left[index] !== right[index]) return false;
  }
  return true;
};

/** What is left of one revision's diff budget: patch bytes to give, and lines diffs may add and remove. */
interface DiffBudget {
  patchBytes: number;
  editLines: number;
}

/**
 * Builds the unified diff hunks, without file headers, that turn `before`
 * into `after`; a missing side counts as an empty file. Returns the hunks as
 * one string, empty when both sides have no lines, or the reason no patch is
 * given. Takes the lines its diff adds and removes from `budget.editLines`;
 * the caller takes the patch's bytes from `budget.patchBytes`.
 */
const buildPatch = (
  before: Uint8Array | undefined,
  after: Uint8Array | undefined,
  budget: DiffBudget,
): string | { readonly omitted: PatchOmitted } => {
  const beforeBytes = before ?? new Uint8Array();
  const afterBytes = after ?? new Uint8Array();
  if (beforeBytes.length > MAX_PATCH_BYTES || afterBytes.length > MAX_PATCH_BYTES) {
    return { omitted: "tooLarge" };
  }
  // Every byte one side has beyond the other is in some added or removed
  // line, so the patch is at least that long.
  if (Math.abs(afterBytes.length - beforeBytes.length) > budget.patchBytes) {
    return { omitted: "tooLarge" };
  }
  const beforeText = decodeText(beforeBytes);
  const afterText = decodeText(afterBytes);
  if (beforeText === null || afterText === null) return { omitted: "binary" };

  // A file added or removed needs no diff: every line is added or removed.
  const maxEditLength = Math.min(MAX_EDIT_LINES, budget.editLines);
  if (beforeText === "" || afterText === "" || maxEditLength <= 0) {
    return buildReplacementHunk(beforeText, afterText);
  }
  const structured = structuredPatch("", "", beforeText, afterText, undefined, undefined, {
    context: CONTEXT_LINES,
    maxEditLength,
  });
  if (structured === undefined) {
    budget.editLines -= maxEditLength;
    return buildReplacementHunk(beforeText, afterText);
  }
  for (const hunk of structured.hunks) {
    for (const line of hunk.lines) {
      if (line.startsWith("+") || line.startsWith("-")) budget.editLines -= 1;
    }
  }
  return formatPatch(structured, OMIT_HEADERS);
};

/** Decodes `bytes` as UTF-8 text. Returns null when they hold a NUL byte or are not valid UTF-8. */
const decodeText = (bytes: Uint8Array): string | null => {
  if (bytes.includes(0)) return null;
  try {
    return utf8Decoder.decode(bytes);
  } catch {
    return null;
  }
};

/**
 * Builds one hunk that removes every line of `before` and adds every line of
 * `after`, for a file whose diff gave up. Returns an empty string when both
 * sides have no lines.
 */
const buildReplacementHunk = (before: string, after: string): string => {
  const removed = buildHunkLines("-", before);
  const added = buildHunkLines("+", after);
  if (removed.count === 0 && added.count === 0) return "";
  // `diff -u` writes the start of a side with no lines as 0.
  const oldStart = removed.count === 0 ? 0 : 1;
  const newStart = added.count === 0 ? 0 : 1;
  return `@@ -${oldStart},${removed.count} +${newStart},${added.count} @@\n${removed.text}${added.text}`;
};

/**
 * Returns every line of `text` prefixed with `prefix` and ending in a newline,
 * followed by the `\ No newline at end of file` marker when `text` does not end
 * in one, and the number of lines.
 */
const buildHunkLines = (
  prefix: "-" | "+",
  text: string,
): { readonly text: string; readonly count: number } => {
  if (text === "") return { text: "", count: 0 };
  const endsInNewline = text.endsWith("\n");
  const lines = (endsInNewline ? text.slice(0, -1) : text).split("\n");
  const body = lines.map((line) => `${prefix}${line}\n`).join("");
  return {
    text: endsInNewline ? body : `${body}\\ No newline at end of file\n`,
    count: lines.length,
  };
};
