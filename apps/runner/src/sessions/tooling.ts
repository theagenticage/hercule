/**
 * What the runner puts on this machine once, at start, so that every session it
 * hosts can reach Hydra: the `hydra` binary on the directory sessions get at
 * the front of their `PATH` (spec 15 section 2), and the Claude plugin
 * directory the skill is materialized into (spec 06 section 9.3).
 *
 * Refreshed rather than written once, exactly like the symlink: an upgraded
 * binary has to take over an older build's link and an older build's skill
 * text, and nothing else on the machine ever rewrites either.
 *
 * Synchronous, because runner start has nothing else to do while it waits and
 * a session may not be placed here before it is done.
 *
 * The link points at `process.execPath`, so it is the `hydra` CLI only when the
 * runner is the compiled binary: under `bun run` it points at bun, and a
 * session that calls `hydra` gets bun instead. The daemon warns about that at
 * start rather than leaving a session to discover it.
 */
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runnerDirIn } from "@hercule/home";
import { VERSION } from "@hercule/home/version";

export interface Tooling {
  /** `<home>/runner/bin`: prepended to every session's `PATH`. */
  readonly binDir: string;
  /**
   * hydra-as-a-tool as every adapter takes it, assembled here so the daemon
   * carries one value rather than rebuilding it from the parts.
   */
  readonly hydraTool: {
    readonly skill: string;
    readonly claudePluginDir: string;
  };
}

export interface ToolingRequest {
  readonly home: string;
  /** This runner's own storage directory, which its identity owns. */
  readonly storageDir: string;
  /** The running binary the session's `hydra` is pointed at. */
  readonly execPath: string;
  readonly skill: string;
}

/** The minimum a Claude plugin directory is loadable with. */
const manifest = (): string =>
  `${JSON.stringify(
    {
      name: "hydra",
      description: "Reach the Hydra controller this session runs under.",
      version: VERSION,
    },
    null,
    2,
  )}\n`;

/** The frontmatter that makes a `SKILL.md` a skill the harness can find by name. */
const skillFile = (skill: string): string =>
  `---\nname: hydra\ndescription: How to reach the Hydra controller this session runs under - the hydra CLI on PATH, its help, and what a 403 means.\n---\n\n${skill}`;

export const prepareTooling = ({ home, storageDir, execPath, skill }: ToolingRequest): Tooling => {
  const binDir = join(runnerDirIn(home), "bin");
  mkdirSync(binDir, { recursive: true });
  const link = join(binDir, "hydra");
  // Removed rather than checked: what is there points at a build that may be
  // gone, and `symlinkSync` will not overwrite.
  rmSync(link, { force: true });
  symlinkSync(execPath, link);

  const claudePluginDir = join(storageDir, "claude-plugin");
  mkdirSync(join(claudePluginDir, ".claude-plugin"), { recursive: true });
  writeFileSync(join(claudePluginDir, ".claude-plugin", "plugin.json"), manifest());
  const skillDir = join(claudePluginDir, "skills", "hydra");
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, "SKILL.md"), skillFile(skill));

  return { binDir, hydraTool: { skill, claudePluginDir } };
};
