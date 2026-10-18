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
 * The most lines a diff may add and remove before it gives up. jsdiff's time
 * grows with the square of this number: at 1000 the worst case, two 1 MiB
 * files with nothing in common, takes about 100 ms, so one file cannot stall
 * the controller. A file with more changes than this gets one hunk that
 * removes every old line and adds every new line.
 */
const MAX_EDIT_LINES = 1000;

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
 *   1 MiB in total (`tooLarge`).
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
  let patchBytesSoFar = 0;
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

    const patch = buildPatch(before?.content, after?.content);
    if (typeof patch !== "string") {
      changes.push({ path, change, mode, patch: null, patchOmitted: patch.omitted });
      continue;
    }
    const patchBytes = utf8Encoder.encode(patch).length;
    if (patchBytesSoFar + patchBytes > MAX_PATCH_BYTES) {
      changes.push({ path, change, mode, patch: null, patchOmitted: "tooLarge" });
      continue;
    }
    patchBytesSoFar += patchBytes;
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

/**
 * Builds the unified diff hunks, without file headers, that turn `before`
 * into `after`; a missing side counts as an empty file. Returns the hunks as
 * one string, empty when both sides have no lines, or the reason no patch is
 * given.
 */
const buildPatch = (
  before: Uint8Array | undefined,
  after: Uint8Array | undefined,
): string | { readonly omitted: PatchOmitted } => {
  const beforeBytes = before ?? new Uint8Array();
  const afterBytes = after ?? new Uint8Array();
  if (beforeBytes.length > MAX_PATCH_BYTES || afterBytes.length > MAX_PATCH_BYTES) {
    return { omitted: "tooLarge" };
  }
  const beforeText = decodeText(beforeBytes);
  const afterText = decodeText(afterBytes);
  if (beforeText === null || afterText === null) return { omitted: "binary" };

  const structured = structuredPatch("", "", beforeText, afterText, undefined, undefined, {
    context: CONTEXT_LINES,
    maxEditLength: MAX_EDIT_LINES,
  });
  if (structured === undefined) return buildReplacementHunk(beforeText, afterText);
  // An added or removed empty file has no hunks, and `formatPatch` writes a
  // lone newline for a patch without hunks.
  return structured.hunks.length === 0 ? "" : formatPatch(structured, OMIT_HEADERS);
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
