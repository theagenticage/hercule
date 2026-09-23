/**
 * Prepares what every session on this runner needs to reach Hercule. The runner
 * does this at start:
 *
 * - it links the `hercule` binary into the directory that goes at the front of
 *   every session's `PATH` (spec 15 section 2);
 * - it writes the Claude plugin directory that holds the skill (spec 06
 *   section 9.3).
 *
 * Both are rewritten at every start, not only the first. An upgraded binary has
 * to replace the symlink and the skill text an older build left behind, and
 * nothing else on the machine rewrites them.
 *
 * The work is synchronous, because runner start has nothing else to do while it
 * waits, and no session may be placed here before it is done.
 *
 * The symlink points at `process.execPath`, so it is the `hercule` CLI only when
 * the runner is the compiled binary. Under `bun run` it points at bun, and a
 * session that calls `hercule` gets bun instead. The daemon warns about this at
 * start, so a session does not have to discover it.
 */
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { locateRunnerDir } from "@hercule/home";
import { VERSION } from "@hercule/home/version";

export interface Tooling {
  /** `<home>/runner/bin`: prepended to every session's `PATH`. */
  readonly binDir: string;
  /**
   * The Hercule tool in the shape every adapter takes. It is built here so the
   * daemon passes one value around instead of rebuilding it from its parts.
   */
  readonly herculeTool: {
    readonly skill: string;
    readonly claudePluginDir: string;
  };
}

export interface ToolingRequest {
  readonly home: string;
  /** This runner's storage directory, which belongs to its current identity. */
  readonly storageDir: string;
  /** The path of the running binary. The `hercule` symlink points at it. */
  readonly execPath: string;
  readonly skill: string;
}

/** Builds the smallest `plugin.json` that lets Claude load the plugin directory. */
const buildManifest = (): string =>
  `${JSON.stringify(
    {
      name: "hercule",
      description: "Reach the Hercule controller this session runs under.",
      version: VERSION,
    },
    null,
    2,
  )}\n`;

/** Builds the `SKILL.md` text: the skill, after the frontmatter the harness needs to find it by name. */
const buildSkillFile = (skill: string): string =>
  `---\nname: hercule\ndescription: How to reach the Hercule controller this session runs under - the hercule CLI on PATH, its help, and what a 403 means.\n---\n\n${skill}`;

export const prepareTooling = ({ home, storageDir, execPath, skill }: ToolingRequest): Tooling => {
  const binDir = join(locateRunnerDir(home), "bin");
  mkdirSync(binDir, { recursive: true });
  const link = join(binDir, "hercule");
  // Remove the old link without inspecting it: it may point at a build that no
  // longer exists, and `symlinkSync` does not overwrite an existing file.
  rmSync(link, { force: true });
  symlinkSync(execPath, link);

  const claudePluginDir = join(storageDir, "claude-plugin");
  mkdirSync(join(claudePluginDir, ".claude-plugin"), { recursive: true });
  writeFileSync(join(claudePluginDir, ".claude-plugin", "plugin.json"), buildManifest());
  const skillDir = join(claudePluginDir, "skills", "hercule");
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, "SKILL.md"), buildSkillFile(skill));

  return { binDir, herculeTool: { skill, claudePluginDir } };
};
