/**
 * Finds the user's own material on this machine - skills and instructions
 * from the default install location of each harness - and makes it visible to
 * one Thread (spec 06 section 9.1). This is the only code in the runner that
 * knows those default locations. Only the session context imports it, and
 * dep-lint enforces that, so no other session, probe, install or login can
 * reach the user's material by accident.
 *
 * Claude Code gets directory symlinks inside its instance home, because that
 * is where it reads the user's material from. Codex and pi get nothing
 * written: their instance homes are shared by every session of the instance,
 * so a link there would leak into sessions that are not Threads. Their
 * adapters pass the paths returned here to the harness instead.
 */
import {
  existsSync,
  lstatSync,
  readFileSync,
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
import { CLAUDE_CODE, CODEX, PI, type UserMaterial } from "../providers";

/**
 * User Material with no paths. A Claude Code Thread always gets it, because
 * Claude reads the user's material through links in its instance home. Any
 * other Thread gets it when the runner finds none of the user's material.
 */
const NO_PATHS: UserMaterial = {
  skillDirs: [],
  promptTemplateDirs: [],
  instructionsFile: undefined,
};

/**
 * The entries of the user's `.claude` directory that a Thread sees. A skill,
 * an agent or a command among them can still approve tools or run hooks while
 * it is active, just as it does in the user's own Claude Code. The user's
 * `settings.json` and `plugins/` are left out on purpose: they would add hooks
 * and permission rules to every Thread, all the time.
 */
const CLAUDE_ENTRIES = ["skills", "agents", "commands", "rules", "CLAUDE.md"] as const;

/**
 * The user's material for one Thread, and a warning for each part of it the
 * runner found but could not use.
 */
interface FoundMaterial {
  readonly material: UserMaterial;
  readonly warnings: ReadonlyArray<string>;
}

/** Checks that a filesystem error means nothing is at the path. */
const isMissingPath = (error: unknown): boolean => {
  const code = (error as { readonly code?: unknown } | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
};

/**
 * Picks the user's instructions file: the first of `candidates` that is a
 * regular file (following symlinks), can be read, and has text `isUsable`
 * accepts. Returns that file, or undefined when no candidate qualifies, and a
 * warning for each candidate that exists but could not be read.
 *
 * A candidate that is missing, is not a regular file, has text `isUsable`
 * refuses, or is a file already tried under another name is skipped quietly. That is how Codex and pi themselves
 * pick the file. A read error is skipped too, as both harnesses skip it, but
 * the user is told: otherwise their instructions would disappear without a
 * trace.
 */
const findInstructionsFile = (
  candidates: ReadonlyArray<string>,
  isUsable: (text: string) => boolean,
): { readonly path: string | undefined; readonly warnings: ReadonlyArray<string> } => {
  const warnings: Array<string> = [];
  const tried = new Set<string>();
  for (const path of candidates) {
    try {
      const stats = statSync(path);
      // On a filesystem that ignores case, such as macOS's by default,
      // `AGENTS.md` and `AGENTS.MD` are one file, and one warning is enough.
      const identity = `${String(stats.dev)}:${String(stats.ino)}`;
      if (tried.has(identity)) continue;
      tried.add(identity);
      if (stats.isFile() && isUsable(readFileSync(path, "utf8"))) return { path, warnings };
    } catch (error) {
      if (isMissingPath(error)) continue;
      const reason = error instanceof Error ? error.message : String(error);
      warnings.push(`Did not read ${path} into the Thread's instructions: ${reason}`);
    }
  }
  return { path: undefined, warnings };
};

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
 * the same instance can also start at once without tripping over each other.
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
 * Links each entry of the user's `.claude` directory that exists into the
 * instance home, and removes links whose source is gone. Returns a warning
 * for each entry the user has that it did not link, including one a
 * filesystem error stopped.
 *
 * Claude Code loads these entries only when its settings sources include the
 * user's, which the adapter asks for only for a Thread. Other sessions of the
 * instance share the same home but never see the links.
 *
 * The links point at whole directories, so symlinks inside them, like the
 * relative ones a skill manager makes, resolve as they do for the user.
 */
const linkClaudeMaterial = (home: string, instanceHome: string): ReadonlyArray<string> =>
  CLAUDE_ENTRIES.flatMap((name) => {
    const source = join(home, ".claude", name);
    try {
      const warning = linkEntry(source, join(instanceHome, name));
      return warning === undefined ? [] : [warning];
    } catch (error) {
      // A broken instance home fails every entry, but only the entries the
      // user has are worth a warning.
      if (!existsSync(source)) return [];
      const reason = error instanceof Error ? error.message : String(error);
      return [`Did not link ${source} into the Thread: ${reason}`];
    }
  });

/**
 * Returns the User Material of a Codex Thread, which holds only the user's
 * instructions file, or no paths when the user has none. Also returns a
 * warning for each instructions file that exists but could not be read.
 *
 * The Codex home is `CODEX_HOME` when the runner has it set to a non-empty
 * value, as Codex itself reads it, and otherwise the `.codex` directory under
 * the user's home. The instructions file is the first of `AGENTS.override.md`
 * and `AGENTS.md` there that can be read and has more than white space in it.
 * That is Codex's own rule: an empty or unreadable override falls through to
 * `AGENTS.md`.
 *
 * Skills need no path. A Codex Thread keeps the real `HOME`, so Codex finds
 * the user's skills there by itself (see `prepareEnv` in
 * `providers/codex/adapter.ts`).
 */
const findCodexMaterial = (
  home: string,
  env: Readonly<Record<string, string | undefined>>,
): FoundMaterial => {
  const codexHome =
    env["CODEX_HOME"] === undefined || env["CODEX_HOME"] === ""
      ? join(home, ".codex")
      : env["CODEX_HOME"];
  const instructions = findInstructionsFile(
    [join(codexHome, "AGENTS.override.md"), join(codexHome, "AGENTS.md")],
    (text) => text.trim() !== "",
  );
  return {
    material: { ...NO_PATHS, instructionsFile: instructions.path },
    warnings: instructions.warnings,
  };
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
 * Returns the User Material of a pi Thread: the shared skills directory and
 * pi's own, pi's prompt templates directory, and the instructions file pi
 * itself would pick. Each directory is included only when it exists. Also
 * returns a warning for each instructions file that exists but could not be
 * read.
 *
 * An unreadable file must never reach pi: pi takes the value of
 * `--append-system-prompt` as text when it cannot read it as a file, so the
 * Thread would get the file's path as its instructions.
 */
const findPiMaterial = (home: string): FoundMaterial => {
  const agentDir = join(home, ".pi", "agent");
  const instructions = findInstructionsFile(
    PI_INSTRUCTIONS_NAMES.map((name) => join(agentDir, name)),
    () => true,
  );
  return {
    material: {
      skillDirs: [join(home, ".agents", "skills"), join(agentDir, "skills")].filter((path) =>
        existsSync(path),
      ),
      promptTemplateDirs: [join(agentDir, "prompts")].filter((path) => existsSync(path)),
      instructionsFile: instructions.path,
    },
    warnings: instructions.warnings,
  };
};

/**
 * Provisions the user's material for one Thread of `providerId`, read from the
 * default locations under `env.HOME`, and returns the paths the adapter
 * passes to the harness. For Claude Code it writes links to that material
 * into `instanceHome` and returns no paths; for every other provider it
 * writes nothing. Returns no paths when `env` has no `HOME` or the provider
 * has no material.
 *
 * Never fails. A missing source is skipped quietly, and a filesystem error is
 * logged as a warning and skipped, because a Thread must still start without
 * the user's material.
 */
export const provisionUserMaterial = (
  providerId: string,
  instanceHome: string,
  env: Readonly<Record<string, string | undefined>>,
): Effect.Effect<UserMaterial> =>
  Effect.gen(function* () {
    const home = env["HOME"];
    if (home === undefined || home === "") return NO_PATHS;
    const found = yield* Effect.sync((): FoundMaterial => {
      switch (providerId) {
        case CLAUDE_CODE:
          return { material: NO_PATHS, warnings: linkClaudeMaterial(home, instanceHome) };
        case CODEX:
          return findCodexMaterial(home, env);
        case PI:
          return findPiMaterial(home);
        default:
          return { material: NO_PATHS, warnings: [] };
      }
    });
    for (const warning of found.warnings) yield* Effect.logWarning(warning);
    return found.material;
  });
