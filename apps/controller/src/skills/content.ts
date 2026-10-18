/**
 * Checks a skill's content against the content rules of the public API
 * (spec 11 §2 `skill`, "The content rules"), and reads from a skill that
 * passes them what its Skill Revision records: its files, its hash, its
 * `description` and its `approvalEffects`.
 *
 * Every origin of content goes through this one function: an archive sent to
 * `skill.import` or `skill.propose`, and a tree an update check fetches. So a
 * skill is held to the same rules whichever way it arrives.
 */
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { isAlias, isMap, isNode, isScalar, parseDocument, visit, type Document } from "yaml";
import {
  BUILT_IN_SKILL_NAME,
  MAX_SKILL_FILES,
  SkillName,
  type SkillApprovalEffects,
} from "@hercule/contract";
import {
  compareSkillPaths,
  computeSkillRevisionHash,
  splitUstarPath,
  type SkillArchiveEntry,
  type SkillFile,
} from "@hercule/protocol";

/** What a skill that passes the content rules holds, as its Skill Revision records it. */
export interface CheckedSkillContent {
  /** The skill's files, sorted by `compareSkillPaths`. Directories are not content. */
  readonly files: ReadonlyArray<SkillFile>;
  readonly revisionHash: string;
  /** The total bytes of the files' content. */
  readonly sizeBytes: number;
  /** The `description` in the frontmatter of `SKILL.md`. */
  readonly description: string;
  readonly approvalEffects: SkillApprovalEffects;
}

/**
 * The content broke one or more content rules. `issues` lists every broken
 * rule at once, each one saying what was wrong and what to do.
 */
export class SkillContentRefused extends Data.TaggedError("SkillContentRefused")<{
  readonly issues: ReadonlyArray<string>;
}> {}

const MAX_SKILL_MD_BYTES = 1024 * 1024;
const SKILL_MD = "SKILL.md";

const CONTROL_CHARACTER = /\p{Cc}/u;
const CONTROL_CHARACTERS = /\p{Cc}/gu;
const DEFAULT_IGNORABLE_CODE_POINTS = /\p{Default_Ignorable_Code_Point}/gu;

/**
 * Checks a skill's archive entries against every content rule, and fails with
 * `SkillContentRefused` listing every rule the content breaks. Returns the
 * skill's files, hash and the facts its Skill Revision records when the
 * content passes.
 *
 * `name` is the skill's name: the folder name an import or a proposal sends,
 * or the Skill's name for an update check. The entries' paths are relative to
 * the skill's root. The 10 MiB cap on the archive is not checked here: the
 * HTTP layer refuses a larger body before the archive is read.
 */
export const checkSkillContent = (
  name: string,
  entries: ReadonlyArray<SkillArchiveEntry>,
): Effect.Effect<CheckedSkillContent, SkillContentRefused> =>
  Effect.gen(function* () {
    const issues: Array<string> = [];
    const showPath = (path: string): string => `\`${escapeControlCharacters(`${name}/${path}`)}\``;

    const fileEntries = entries.filter((entry) => entry.kind === "file");

    // The issues are listed in the order of the rules in spec 11.
    const skillMd = fileEntries.find((entry) => entry.path === SKILL_MD);
    const frontmatter =
      skillMd === undefined
        ? undefined
        : readFrontmatter(name, skillMd.content, showPath(SKILL_MD));
    if (skillMd === undefined) {
      issues.push(
        `\`${escapeControlCharacters(name)}\` has no \`SKILL.md\` at its root. Add one, with a \`name\` and a \`description\` in its frontmatter.`,
      );
    }
    if (frontmatter !== undefined) issues.push(...frontmatter.issues);
    if (skillMd !== undefined && skillMd.content.byteLength > MAX_SKILL_MD_BYTES) {
      issues.push(
        `${showPath(SKILL_MD)} is ${formatMebibytes(skillMd.content.byteLength)}. A \`SKILL.md\` may be at most 1 MiB; move long material into files beside it.`,
      );
    }

    issues.push(...listNameIssues(name));

    for (const entry of entries) {
      if (entry.kind === "symlink") {
        issues.push(
          `${showPath(entry.path)} is a symbolic link. A skill archive holds only files and folders; read the folder with \`hercule skill import\` or the desktop app, which put a link's target in the archive when the target is inside the skill's folder.`,
        );
      } else if (entry.kind === "other") {
        issues.push(
          `${showPath(entry.path)} is neither a file nor a folder. A skill archive holds only files and folders; remove it from the skill.`,
        );
      }
    }

    for (const entry of fileEntries) {
      if (entry.mode !== 0o644 && entry.mode !== 0o755) {
        issues.push(
          `${showPath(entry.path)} has mode \`${entry.mode.toString(8)}\`. A file's mode must be \`644\` or \`755\`.`,
        );
      }
    }

    // Past the cap the paths are not checked: the content is refused anyway,
    // and an archive of many thousand files would only make the check slow.
    if (fileEntries.length > MAX_SKILL_FILES) {
      issues.push(
        `\`${escapeControlCharacters(name)}\` has ${fileEntries.length.toLocaleString("en-US")} files. A skill holds at most 1,000; remove the files it does not need.`,
      );
    } else {
      issues.push(
        ...listPathIssues(
          fileEntries.map((entry) => entry.path),
          showPath,
        ),
      );
    }

    // Content with no description always has an issue; testing the
    // description as well lets the compiler see it is a string below.
    if (issues.length > 0 || frontmatter?.description === undefined) {
      return yield* new SkillContentRefused({ issues });
    }

    const files: Array<SkillFile> = fileEntries
      .map((entry) => ({
        path: entry.path,
        mode: entry.mode === 0o755 ? ("755" as const) : ("644" as const),
        content: entry.content,
      }))
      .sort((a, b) => compareSkillPaths(a.path, b.path));
    return {
      files,
      revisionHash: yield* computeSkillRevisionHash(files),
      sizeBytes: files.reduce((total, file) => total + file.content.byteLength, 0),
      description: frontmatter.description,
      approvalEffects: frontmatter.approvalEffects,
    };
  });

/** Returns the issue with the skill's name, or nothing when the name follows the rule. */
const listNameIssues = (name: string): ReadonlyArray<string> => {
  if (name === BUILT_IN_SKILL_NAME) {
    return [
      `\`${BUILT_IN_SKILL_NAME}\` is the built-in skill's name. Rename the folder and the \`name\` in its \`SKILL.md\`.`,
    ];
  }
  if (!Schema.is(SkillName)(name)) {
    return [
      `\`${escapeControlCharacters(name)}\` is not a valid skill name. A name is at most 64 characters of lowercase letters, digits and single hyphens between them; rename the folder and the \`name\` in its \`SKILL.md\`.`,
    ];
  }
  return [];
};

/**
 * Checks a skill's file paths against the path rules of the content rules,
 * and returns the issue messages, or an empty list when every path follows
 * them. The paths are relative to the skill's root, and each message shows a
 * path as given, with no skill name before it.
 *
 * A caller that holds files of a skill from somewhere other than
 * `checkSkillContent`, such as a promotion bundle, uses this to hold their
 * paths to the same rules before it writes them to disk.
 */
export const listSkillPathIssues = (paths: ReadonlyArray<string>): ReadonlyArray<string> =>
  listPathIssues(paths, (path) => `\`${escapeControlCharacters(path)}\``);

/**
 * Returns the issues with a skill's file paths: unsafe paths, paths a disk
 * that ignores case could not hold apart, and paths too long for a tar
 * archive. `showPath` formats a path for a message.
 */
const listPathIssues = (
  paths: ReadonlyArray<string>,
  showPath: (path: string) => string,
): ReadonlyArray<string> => {
  const issues: Array<string> = [];
  // Only safe paths are compared and measured, so an unsafe path is
  // reported once, as unsafe.
  const safePaths: Array<string> = [];
  for (const path of paths) {
    const issue = findUnsafePathIssue(path, showPath(path));
    if (issue === null) safePaths.push(path);
    else issues.push(issue);
  }
  issues.push(...listPathCollisionIssues(safePaths, showPath));
  for (const path of safePaths) {
    if (splitUstarPath(path) === null) {
      issues.push(
        `${showPath(path)} is too long for a tar archive. Shorten its folder names or its file name.`,
      );
    }
  }
  return issues;
};

/**
 * Returns the issue with a file's path when the path could reach outside the
 * skill's folder or cannot be written safely, or null when it is safe. A safe
 * path is relative, uses `/`, and has no empty, `.` or `..` segment and no
 * control character.
 */
const findUnsafePathIssue = (path: string, shownPath: string): string | null => {
  if (CONTROL_CHARACTER.test(path)) {
    return `${shownPath} has a control character in its path. Rename it without one.`;
  }
  const segments = path.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    return `${shownPath} is not a path inside the skill. Paths must stay inside the skill's folder.`;
  }
  return null;
};

/**
 * Returns the issues with paths that a disk which ignores case could not hold
 * apart: two equal paths, a file whose path is a folder of another file's
 * path, and one folder spelled two ways. Paths are compared segment by
 * segment, each folded by `foldPathSegment`.
 */
const listPathCollisionIssues = (
  paths: ReadonlyArray<string>,
  showPath: (path: string) => string,
): ReadonlyArray<string> => {
  // Each segment is folded once. A path's key is its folded segments joined
  // with `/`, so the key of a folder is the start of the key of every path
  // inside it, and is built one segment at a time.
  const splitPaths = paths.map((path) => {
    const segments = path.split("/");
    return { path, segments, foldedSegments: segments.map(foldPathSegment) };
  });

  const issues: Array<string> = [];
  const filesByKey = new Map<string, string>();
  for (const { path, foldedSegments } of splitPaths) {
    const key = foldedSegments.join("/");
    const earlier = filesByKey.get(key);
    if (earlier === undefined) filesByKey.set(key, path);
    else if (earlier === path) {
      issues.push(`${showPath(path)} appears twice in the archive. Each path may appear once.`);
    } else if (earlier.toLowerCase() === path.toLowerCase()) {
      issues.push(
        `${showPath(earlier)} and ${showPath(path)} differ only in case. Rename one of them.`,
      );
    } else {
      issues.push(
        `${showPath(earlier)} and ${showPath(path)} name one file on a disk that ignores case, such as macOS's. Rename one of them.`,
      );
    }
  }

  // Each folder's spelling is the spelling of its last segment, keyed by the
  // folded path of the whole folder, so a clash high up in the tree is
  // reported once and not again for every folder below it.
  const folders = new Map<string, { readonly segment: string; readonly path: string }>();
  const reportedFolderClashes = new Set<string>();
  const reportedFileFolders = new Set<string>();
  for (const { path, segments, foldedSegments } of splitPaths) {
    let key = "";
    for (let depth = 1; depth < segments.length; depth++) {
      key = depth === 1 ? foldedSegments[0]! : `${key}/${foldedSegments[depth - 1]!}`;
      const segment = segments[depth - 1]!;

      const file = filesByKey.get(key);
      if (file !== undefined && !reportedFileFolders.has(key)) {
        reportedFileFolders.add(key);
        issues.push(
          `${showPath(file)} is a file, and ${showPath(path)} needs it to be a folder. Rename one of them.`,
        );
      }

      const first = folders.get(key);
      if (first === undefined) folders.set(key, { segment, path });
      else if (first.segment !== segment && !reportedFolderClashes.has(`${key}\0${segment}`)) {
        reportedFolderClashes.add(`${key}\0${segment}`);
        issues.push(
          `${showPath(first.path)} and ${showPath(path)} spell one folder two ways. Use one spelling.`,
        );
      }
    }
  }
  return issues;
};

/**
 * Returns the form of one path segment under which every two names that a
 * disk which ignores case may treat as one name are equal.
 *
 * Disks fold names in different ways, so this fold is wider than any one of
 * them, and a name refused here is refused on every disk:
 *
 * - NFKD maps compatibility forms to plain letters: `ﬀ` to `ff`, `ſ` to `s`.
 * - Upper case then lower case maps `ß` to `ss` and `ς` to `σ`, which a
 *   lower case alone keeps apart.
 * - Default-ignorable code points, such as a zero-width space or a leading
 *   byte order mark, are dropped, because some disks ignore them.
 */
const foldPathSegment = (segment: string): string =>
  segment
    .normalize("NFKD")
    .toUpperCase()
    .toLowerCase()
    .normalize("NFKD")
    .replace(DEFAULT_IGNORABLE_CODE_POINTS, "");

/** What the frontmatter of `SKILL.md` gives, and the issues found in it. */
interface Frontmatter {
  readonly issues: ReadonlyArray<string>;
  /** Undefined when the frontmatter has no `description` that is text. */
  readonly description: string | undefined;
  readonly approvalEffects: SkillApprovalEffects;
}

const NO_APPROVAL_EFFECTS: SkillApprovalEffects = { allowedTools: null, hooks: null };

/**
 * Reads the YAML frontmatter of `SKILL.md`: the text between a first line of
 * `---` and the next line of `---`. Returns the issues with it, its
 * `description`, and its `approvalEffects`.
 *
 * Duplicate keys are found here rather than by the YAML library, because the
 * library's check reports them as syntax errors, compares keys that are equal
 * as strings (`1` and `"1"`) as different, and stops the frontmatter from
 * being read further. Keys are checked in every mapping, also inside `hooks`,
 * because a duplicate anywhere could hide a value from `approvalEffects`.
 */
const readFrontmatter = (name: string, content: Uint8Array, shownPath: string): Frontmatter => {
  const refuse = (issue: string): Frontmatter => ({
    issues: [issue],
    description: undefined,
    approvalEffects: NO_APPROVAL_EFFECTS,
  });

  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(content);
  } catch {
    return refuse(`${shownPath} is not valid UTF-8 text. Save it as UTF-8.`);
  }
  const lines = text.split("\n").map((line) => line.replace(/\r$/, ""));
  const end = lines.indexOf("---", 1);
  if (lines[0] !== "---" || end === -1) {
    return refuse(
      `${shownPath} has no YAML frontmatter. Start it with a \`---\` line, then \`name\` and \`description\`, then another \`---\` line.`,
    );
  }

  const yamlText = lines.slice(1, end).join("\n");
  // Returns the line of SKILL.md that an offset into the frontmatter is on.
  // The frontmatter starts on the second line, after `---`.
  const findLine = (offset: number): string =>
    String(yamlText.slice(0, offset).split("\n").length + 1);
  const document = parseDocument(yamlText, {
    prettyErrors: false,
    uniqueKeys: false,
    // Treat `<<` as an ordinary key, so a merge cannot bring in keys unseen.
    merge: false,
    // Refuse a key that is a list or a mapping, which has no text to compare.
    stringKeys: true,
  });
  // Checked before the errors, so an aliased key is reported as an alias.
  const reference = findYamlReference(document);
  if (reference !== undefined) {
    return refuse(
      `${shownPath} uses a YAML ${reference.kind} at line ${findLine(reference.offset)}. Write each value out in full: anchors, aliases and tags are not allowed in a skill's frontmatter.`,
    );
  }
  if (document.errors.length > 0) {
    const error = document.errors[0]!;
    if (error.code === "NON_STRING_KEY") {
      return refuse(
        `${shownPath} has a key that is not text at line ${findLine(error.pos[0])}. Write every key in its frontmatter as plain text.`,
      );
    }
    return refuse(
      `${shownPath} has frontmatter that is not valid YAML at line ${findLine(error.pos[0])}: ${error.message}. Fix the YAML between the \`---\` lines.`,
    );
  }
  if (!isMap(document.contents)) {
    return refuse(
      `${shownPath} has frontmatter that is not a YAML mapping. Write it as \`key: value\` lines.`,
    );
  }

  const issues: Array<string> = [];
  const reportedKeys = new Set<string>();
  visit(document, {
    Map(_, map) {
      const seen = new Set<string>();
      for (const item of map.items) {
        const key = isScalar(item.key) ? String(item.key.value) : String(item.key);
        if (seen.has(key) && !reportedKeys.has(key)) {
          reportedKeys.add(key);
          issues.push(
            `${shownPath} has \`${key}\` twice in its frontmatter. Each key may appear once.`,
          );
        }
        seen.add(key);
      }
    },
  });

  // The frontmatter is untrusted text, so a failure to convert it is the
  // content's issue, not the controller's. With no alias in the document,
  // nothing known makes the conversion fail.
  let fields: Record<string, unknown>;
  try {
    fields = document.toJS() as Record<string, unknown>;
  } catch {
    return refuse(
      `${shownPath} has frontmatter that could not be read as YAML. Fix the YAML between the \`---\` lines.`,
    );
  }
  const skillName = fields["name"];
  if (skillName === undefined || skillName === null) {
    issues.push(
      `${shownPath} has no \`name\`. Add \`name: ${escapeControlCharacters(name)}\` to its frontmatter.`,
    );
  } else if (skillName !== name) {
    const shownName = typeof skillName === "string" ? skillName : JSON.stringify(skillName);
    issues.push(
      `${shownPath} has \`name: ${escapeControlCharacters(shownName)}\`. A skill's name must match its folder name; rename the folder or the name.`,
    );
  }

  const description = fields["description"];
  if (description === undefined || description === null || description === "") {
    issues.push(
      `${shownPath} has no \`description\`. Add one to its frontmatter: the agent reads it to decide when to use the skill.`,
    );
  } else if (typeof description !== "string") {
    issues.push(
      `${shownPath} has a \`description\` that is not text. Write it as one line of text: the agent reads it to decide when to use the skill.`,
    );
  }

  return {
    issues,
    description: typeof description === "string" && description !== "" ? description : undefined,
    approvalEffects: {
      allowedTools: readAllowedTools(fields["allowed-tools"]),
      hooks: isAbsent(fields["hooks"]) ? null : buildCanonicalJson(fields["hooks"]),
    },
  };
};

/**
 * Returns the first alias, anchor or explicit tag in a YAML document, with the
 * offset in the YAML text where it starts, or undefined when it has none.
 *
 * The frontmatter is read as plain YAML only. Two YAML parsers can resolve
 * an alias or a tag differently, so either could hide an `allowed-tools` from
 * `approvalEffects`. An alias can also make the document a cycle or blow it
 * up in size, and a tag such as `!!set` or `!!binary` changes what a value
 * reads as.
 */
const findYamlReference = (
  document: Document,
): { readonly kind: "alias" | "anchor" | "tag"; readonly offset: number } | undefined => {
  let found: { readonly kind: "alias" | "anchor" | "tag"; readonly offset: number } | undefined;
  visit(document, (_, node) => {
    if (!isNode(node)) return undefined;
    const offset = node.range?.[0] ?? 0;
    if (isAlias(node)) found = { kind: "alias", offset };
    else if (node.anchor !== undefined) found = { kind: "anchor", offset };
    else if (node.tag !== undefined) found = { kind: "tag", offset };
    else return undefined;
    return visit.BREAK;
  });
  return found;
};

/** Checks whether a frontmatter field is missing or has an empty value, which YAML reads as null. */
const isAbsent = (value: unknown): boolean => value === undefined || value === null;

/**
 * Returns the text of `allowed-tools`: the string as written, a list joined
 * with ", ", or null when the field is absent. Any other value becomes its
 * canonical JSON, so no value of the field is ever dropped from the
 * approval effects.
 */
const readAllowedTools = (value: unknown): string | null => {
  if (isAbsent(value)) return null;
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value
      .map((tool) => (typeof tool === "string" ? tool : buildCanonicalJson(tool)))
      .join(", ");
  }
  return buildCanonicalJson(value);
};

/**
 * Converts a value to canonical JSON: the keys of every object sorted, and no
 * spaces. Two values that are equal give the same text, so two revisions'
 * hooks compare as text.
 */
const buildCanonicalJson = (value: unknown): string => JSON.stringify(sortKeys(value));

/** Returns a copy of a JSON value with the keys of every object sorted. */
const sortKeys = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortKeys((value as Record<string, unknown>)[key])]),
    );
  }
  return value;
};

/**
 * Formats a size in bytes as mebibytes with one decimal, such as "1.4 MiB".
 * It rounds up, so a size just past 1 MiB reads "1.1 MiB" and never "1.0 MiB".
 */
const formatMebibytes = (bytes: number): string =>
  `${(Math.ceil((bytes * 10) / (1024 * 1024)) / 10).toFixed(1)} MiB`;

/**
 * Replaces every control character in a text with its `\u` escape, so a
 * message that shows a path or a name stays on one readable line.
 */
const escapeControlCharacters = (text: string): string =>
  text.replace(
    CONTROL_CHARACTERS,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
