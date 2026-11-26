/**
 * Finds the user's own material on this machine - instructions, and for
 * Claude Code its subagent definitions, commands and rules, from the default
 * install location of each harness - and makes it visible to one Thread
 * (spec 06 section 9.1). Skills are not among them: every Thread gets its
 * skills from the Skill Library instead (spec 06 section 9.4).
 *
 * This is the only code in the runner that knows those default locations.
 * Only the session context imports it, and dep-lint enforces that, so no
 * other session, probe, install or login can reach the user's material by
 * accident.
 *
 * Claude Code gets directory symlinks inside its Harness Home, because that
 * is where it reads the user's material from. Codex, pi and Antigravity get
 * nothing written: their Harness Homes are shared by every session of the
 * account, so a link there would leak into sessions that are not Threads.
 * Their adapters use what is returned here instead: Codex and Antigravity add
 * the instructions text to the session's instructions, and pi takes the path
 * of its instructions file as a flag.
 */
import {
  existsSync,
  lstatSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import { ANTIGRAVITY, CLAUDE_CODE, CODEX, PI, type UserMaterial } from "../harnesses";
import { isMissingPath } from "../harnesses/session-files";
import { parseFrontmatter } from "../frontmatter";
import { readFileStart } from "../read-file-start";
import { describeError, escapeControlCharacters } from "../report";

/**
 * User Material with nothing in it. A Claude Code Thread always gets it,
 * because Claude reads the user's material through links in its Harness Home.
 * Any other Thread gets it when the runner finds none of the user's material.
 */
const NO_MATERIAL: UserMaterial = {
  promptTemplateDirs: [],
  instructions: undefined,
  instructionsFile: undefined,
};

/**
 * The most bytes read from one instructions file. Reading more would stall
 * the runner and bloat the Thread's instructions.
 */
const MAX_INSTRUCTIONS_FILE_BYTES = 64 * 1024;

/**
 * The most bytes of text taken from all instructions files of one Thread
 * together. A user can have many rule files, and the sum must stay small too.
 */
const MAX_INSTRUCTIONS_TOTAL_BYTES = 256 * 1024;

/**
 * The entries of the user's `.claude` directory that a Thread sees. An agent
 * or a command among them can still approve tools or run hooks while it is
 * active, just as it does in the user's own Claude Code. The user's
 * `settings.json` and `plugins/` are left out on purpose: they would add hooks
 * and permission rules to every Thread, all the time. `skills` is left out
 * because a Thread's skills come from the Skill Library.
 */
const CLAUDE_ENTRIES = ["agents", "commands", "rules", "CLAUDE.md"] as const;

/**
 * The user's material for one Thread, and a warning for each part of it the
 * runner found but could not use.
 */
interface FoundMaterial {
  readonly material: UserMaterial;
  readonly warnings: ReadonlyArray<string>;
}

/**
 * Creates a function that reads the start of one candidate instructions file:
 * at most `limit` bytes, and `MAX_INSTRUCTIONS_FILE_BYTES` when `limit` is not
 * given. It returns the same result as `readFileStart`, or undefined when the
 * candidate is missing, is not a regular file (following symlinks), or is the
 * same file as one the function already looked at. Any other failure, such as
 * a file that cannot be read, is skipped too and adds a warning to `warnings`,
 * so the user's instructions never disappear without a trace.
 *
 * Every first read goes through `readFileStart`, which opens without waiting.
 * The `stat` before it only tells files apart: on a filesystem that ignores
 * case, such as macOS's by default, `AGENTS.md` and `AGENTS.MD` are one file,
 * and it is read and warned about once.
 */
const createCandidateReader = (warnings: Array<string>) => {
  const buffer = Buffer.alloc(MAX_INSTRUCTIONS_FILE_BYTES);
  const seen = new Set<string>();
  return (path: string, limit: number = buffer.length): ReturnType<typeof readFileStart> => {
    try {
      const stats = statSync(path);
      const identity = `${String(stats.dev)}:${String(stats.ino)}`;
      if (!stats.isFile() || seen.has(identity)) return undefined;
      seen.add(identity);
      return readFileStart(path, buffer.subarray(0, limit));
    } catch (error) {
      if (!isMissingPath(error)) {
        warnings.push(
          `Did not read ${path} into the Thread's instructions: ${describeError(error)}`,
        );
      }
      return undefined;
    }
  };
};

/** Returns the warning for a file whose text was cut at the limit of one file. */
const buildCutWarning = (
  path: string,
  file: { readonly bytesRead: number; readonly size: number },
): string =>
  `Cut ${path} in the Thread's instructions: left out the last ${String(file.size - file.bytesRead)} of its ${String(file.size)} bytes, because of the limit of ${String(MAX_INSTRUCTIONS_FILE_BYTES / 1024)} KiB per file`;

/**
 * Makes `target` a symlink to `source`, or removes a symlink at `target` when
 * `source` no longer exists. Returns a warning when it skipped the entry, or
 * undefined when it did not. Throws when the filesystem fails.
 *
 * A real file or directory at `target` is never touched: the user or the
 * harness put it there, and replacing it would destroy their data.
 *
 * The link is made under a unique temporary name and renamed over the
 * target. A rename is atomic, so a harness starting at the same moment sees
 * either the old link or the new one, never no link at all. Two sessions of
 * the same account can also start at once without tripping over each other.
 */
const linkEntry = (source: string, target: string): string | undefined => {
  const existing = lstatSync(target, { throwIfNoEntry: false });
  if (existing !== undefined && !existing.isSymbolicLink()) {
    return existsSync(source)
      ? `Did not link ${source} into the Thread: ${target} already exists and is not a symlink, so it was left alone. Remove it and start the Thread again to link it.`
      : undefined;
  }
  if (!existsSync(source)) {
    // A link left from when the source existed would now dangle.
    if (existing !== undefined) unlinkSync(target);
    return undefined;
  }
  if (existing !== undefined && readlinkSync(target) === source) return undefined;
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    symlinkSync(source, temporary);
    renameSync(temporary, target);
  } finally {
    rmSync(temporary, { force: true });
  }
  return undefined;
};

/**
 * Removes the `skills` link an earlier runner made in the Harness Home,
 * which pointed at the user's `~/.claude/skills`. Without this, the link
 * would stay, because only the entries `CLAUDE_ENTRIES` names are visited,
 * and Claude would keep loading the user's skills beside the library's.
 * A real directory there, or a link that points anywhere else, is left alone:
 * the runner did not make it. Throws when the filesystem fails.
 */
const removeRetiredSkillsLink = (home: string, harnessHome: string): void => {
  const target = join(harnessHome, "skills");
  const existing = lstatSync(target, { throwIfNoEntry: false });
  if (existing?.isSymbolicLink() && readlinkSync(target) === join(home, ".claude", "skills")) {
    unlinkSync(target);
  }
};

/**
 * Links each entry of the user's `.claude` directory that exists into the
 * Harness Home, and removes links whose source is gone. Returns a warning
 * for each entry the user has that it did not link, including one a
 * filesystem error stopped.
 *
 * Claude Code loads these entries only when its settings sources include the
 * user's, which the adapter asks for only for a Thread. Other sessions of the
 * account share the same home but never see the links.
 *
 * The links point at whole directories, so symlinks inside them, like the
 * relative ones a skill manager makes, resolve as they do for the user.
 */
const linkClaudeMaterial = (home: string, harnessHome: string): ReadonlyArray<string> => {
  const warnings: Array<string> = [];
  try {
    removeRetiredSkillsLink(home, harnessHome);
  } catch (error) {
    if (!isMissingPath(error)) {
      const reason = error instanceof Error ? error.message : String(error);
      warnings.push(`Did not remove the old skills link from ${harnessHome}: ${reason}`);
    }
  }
  for (const name of CLAUDE_ENTRIES) {
    const source = join(home, ".claude", name);
    try {
      const warning = linkEntry(source, join(harnessHome, name));
      if (warning !== undefined) warnings.push(warning);
    } catch (error) {
      // a broken Harness Home fails every entry, but only the entries the
      // user has are worth a warning.
      if (!existsSync(source)) continue;
      const reason = error instanceof Error ? error.message : String(error);
      warnings.push(`Did not link ${source} into the Thread: ${reason}`);
    }
  }
  return warnings;
};

/**
 * Returns the User Material of a Codex Thread, which holds only the text of
 * the user's instructions file, or nothing when the user has none. Also
 * returns a warning for each instructions file that exists but could not be
 * read, and for a text that was cut.
 *
 * The Codex home is `CODEX_HOME` when the runner has it set to a non-empty
 * value, as Codex itself reads it, and otherwise the `.codex` directory under
 * the user's home. The instructions file is the first of `AGENTS.override.md`
 * and `AGENTS.md` there that can be read and has more than white space in its
 * first `MAX_INSTRUCTIONS_FILE_BYTES`. That is Codex's own rule: an empty or
 * unreadable override falls through to `AGENTS.md`.
 */
const findCodexMaterial = (
  home: string,
  env: Readonly<Record<string, string | undefined>>,
): FoundMaterial => {
  const codexHome =
    env["CODEX_HOME"] === undefined || env["CODEX_HOME"] === ""
      ? join(home, ".codex")
      : env["CODEX_HOME"];
  const warnings: Array<string> = [];
  const read = createCandidateReader(warnings);
  for (const path of [join(codexHome, "AGENTS.override.md"), join(codexHome, "AGENTS.md")]) {
    const file = read(path);
    if (file === undefined || file.text.trim() === "") continue;
    if (file.size > file.bytesRead) warnings.push(buildCutWarning(path, file));
    return { material: { ...NO_MATERIAL, instructions: file.text }, warnings };
  }
  return { material: NO_MATERIAL, warnings };
};

/**
 * The names pi looks for in its agent directory when it picks the user's
 * instructions file, in pi's order. The first regular file pi can read wins,
 * even an empty one. pi 0.85.1 and 1.0.0 both use this list.
 */
const PI_INSTRUCTIONS_NAMES = [
  "AGENTS.override.md",
  "AGENTS.md",
  "AGENTS.MD",
  "CLAUDE.md",
  "CLAUDE.MD",
] as const;

/**
 * Returns the User Material of a pi Thread: pi's prompt templates directory,
 * when it exists, and the path of the instructions file pi itself would pick.
 * Also returns a warning for each instructions file that exists but could not
 * be read.
 *
 * pi reads its instructions file itself, so only opening it matters here: a
 * file that opens is picked, even an empty one. An unreadable file must never
 * reach pi, because pi takes the value of `--append-system-prompt` as text
 * when it cannot read it as a file, so the Thread would get the file's path as
 * its instructions.
 */
const findPiMaterial = (home: string): FoundMaterial => {
  const agentDir = join(home, ".pi", "agent");
  const warnings: Array<string> = [];
  const read = createCandidateReader(warnings);
  const instructionsFile = PI_INSTRUCTIONS_NAMES.map((name) => join(agentDir, name)).find(
    (path) => read(path, 0) !== undefined,
  );
  return {
    material: {
      ...NO_MATERIAL,
      promptTemplateDirs: [join(agentDir, "prompts")].filter((path) => existsSync(path)),
      instructionsFile,
    },
    warnings,
  };
};

/** The most entries of `config/rules` that are checked for rules that are always on. */
const MAX_ANTIGRAVITY_RULE_ENTRIES = 100;

/**
 * Returns the text of an Antigravity rule file after its YAML frontmatter when
 * the frontmatter has `trigger` set to exactly the text `always_on`. Returns
 * undefined for a file with no frontmatter, frontmatter that is not valid
 * YAML, or any other trigger: Antigravity does not load such a rule into every
 * conversation either. The frontmatter is Antigravity's own metadata, so it is
 * not part of the text.
 */
const parseAlwaysOnRule = (text: string): string | undefined => {
  const parsed = parseFrontmatter(text);
  return parsed.status === "found" &&
    typeof parsed.value === "object" &&
    parsed.value !== null &&
    "trigger" in parsed.value &&
    parsed.value.trigger === "always_on"
    ? parsed.body
    : undefined;
};

/**
 * Returns the paths of the `.md` entries of `rulesDir`, sorted by file name in
 * byte order, and a warning when the folder cannot be read. Looks at no more
 * than `MAX_ANTIGRAVITY_RULE_ENTRIES` entries and warns once when it skipped
 * the rest. Whether an entry is a regular file is left to the caller. A
 * missing folder is not a problem.
 */
const listRuleCandidates = (
  rulesDir: string,
): { readonly paths: ReadonlyArray<string>; readonly warnings: ReadonlyArray<string> } => {
  let names: Array<string>;
  try {
    names = readdirSync(rulesDir).sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  } catch (error) {
    return {
      paths: [],
      warnings: isMissingPath(error)
        ? []
        : [`Did not read the rules in ${rulesDir}: ${describeError(error)}`],
    };
  }
  const warnings =
    names.length > MAX_ANTIGRAVITY_RULE_ENTRIES
      ? [
          `${rulesDir} has ${String(names.length)} entries; only the first ${String(MAX_ANTIGRAVITY_RULE_ENTRIES)} by name were checked for rules that are always on`,
        ]
      : [];
  const paths = names
    .slice(0, MAX_ANTIGRAVITY_RULE_ENTRIES)
    .filter((name) => name.endsWith(".md"))
    .map((name) => join(rulesDir, name));
  return { paths, warnings };
};

/**
 * Returns the User Material of an Antigravity (`agy`) Thread: the text of the
 * user's instruction files, which Antigravity reads from its gemini directory,
 * `.gemini` under the user's home. It holds no prompt templates apart from
 * skills, so `promptTemplateDirs` stays empty. Also returns a warning for
 * each file or folder it could not look at, for a text that was cut, and for a
 * file left out because of the total limit.
 *
 * Antigravity reads all of these into every conversation, and reads both
 * `AGENTS.md` and `GEMINI.md` when a place has both. The texts are joined, by
 * a blank line, in the order in which the model reported its instructions
 * when it was asked (`AGENTS.md` first at each place):
 *
 * - `AGENTS.md` and `GEMINI.md` in the gemini directory;
 * - `AGENTS.md` and `GEMINI.md` in its `config` folder;
 * - the files of `config/rules` whose YAML frontmatter has
 *   `trigger: always_on`, sorted by file name, without their frontmatter. A
 *   rule with no frontmatter, or with another trigger, is not put into every
 *   conversation, so it is left out.
 *
 * Each file is read once, and a rule is judged by the same text that goes into
 * the instructions: at most `MAX_INSTRUCTIONS_FILE_BYTES` of it. A missing
 * path is skipped quietly, and so is anything that is not a regular file
 * (following symlinks), a text with only white space, and a file that is the
 * same file as an earlier one, such as a `GEMINI.md` that is a symlink to
 * `AGENTS.md`. Any other error, such as a symlink loop, is a warning.
 *
 * The texts add up to at most `MAX_INSTRUCTIONS_TOTAL_BYTES`. A file that does
 * not fit in what is left is left out whole, with a warning, and so is every
 * file after it that does not fit.
 *
 * The `antigravity-acp` folder of the directory is not read by Antigravity, so
 * it is not looked at either.
 */
const findAntigravityMaterial = (home: string): FoundMaterial => {
  const geminiDir = join(home, ".gemini");
  const warnings: Array<string> = [];
  const read = createCandidateReader(warnings);
  const texts: Array<string> = [];
  let totalBytes = 0;

  // Adds the text `pickText` takes from the file at `path`, if it takes any.
  const addFile = (path: string, pickText: (text: string) => string | undefined): void => {
    const file = read(path);
    if (file === undefined) return;
    const text = pickText(file.text);
    if (text === undefined || text.trim() === "") return;
    const bytes = Buffer.byteLength(text);
    if (totalBytes + bytes > MAX_INSTRUCTIONS_TOTAL_BYTES) {
      warnings.push(
        `Left ${path} out of the Thread's instructions: it does not fit in the limit of ${String(MAX_INSTRUCTIONS_TOTAL_BYTES / 1024)} KiB for all files`,
      );
      return;
    }
    if (file.size > file.bytesRead) warnings.push(buildCutWarning(path, file));
    totalBytes += bytes;
    texts.push(text);
  };

  for (const path of [
    join(geminiDir, "AGENTS.md"),
    join(geminiDir, "GEMINI.md"),
    join(geminiDir, "config", "AGENTS.md"),
    join(geminiDir, "config", "GEMINI.md"),
  ]) {
    addFile(path, (text) => text);
  }

  const rules = listRuleCandidates(join(geminiDir, "config", "rules"));
  warnings.push(...rules.warnings);
  for (const path of rules.paths) addFile(path, parseAlwaysOnRule);
  return {
    material: { ...NO_MATERIAL, instructions: texts.length === 0 ? undefined : texts.join("\n\n") },
    warnings,
  };
};

/**
 * Provisions the user's material for one Thread of `harnessId`, read from the
 * default locations under `env.HOME`, and returns what the adapter gives the
 * harness: the instructions text, or the path of the instructions file. For
 * Claude Code it writes links to that material into `harnessHome` and returns
 * nothing else; for every other harness it writes nothing. Returns nothing
 * when `env` has no `HOME` or the harness has no material.
 *
 * The session context calls this at every start frame, which a resume and a
 * fork are, so the instructions text is as current as the files at that
 * moment.
 *
 * Never fails. A missing source is skipped quietly, and a filesystem error is
 * logged as a warning and skipped, because a Thread must still start without
 * the user's material.
 */
export const provisionUserMaterial = (
  harnessId: string,
  harnessHome: string,
  env: Readonly<Record<string, string | undefined>>,
): Effect.Effect<UserMaterial> =>
  Effect.gen(function* () {
    const home = env["HOME"];
    if (home === undefined || home === "") return NO_MATERIAL;
    const found = yield* Effect.sync((): FoundMaterial => {
      switch (harnessId) {
        case CLAUDE_CODE:
          return { material: NO_MATERIAL, warnings: linkClaudeMaterial(home, harnessHome) };
        case CODEX:
          return findCodexMaterial(home, env);
        case PI:
          return findPiMaterial(home);
        case ANTIGRAVITY:
          return findAntigravityMaterial(home);
        default:
          return { material: NO_MATERIAL, warnings: [] };
      }
    });
    // A file name can hold a line break, which would forge a log line.
    for (const warning of found.warnings)
      yield* Effect.logWarning(escapeControlCharacters(warning));
    return found.material;
  });
