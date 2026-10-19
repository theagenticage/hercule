/**
 * Tests, against a real Codex app-server, that the repository skills the
 * runner offers cannot lead Codex to material outside the checkout.
 *
 * Codex scans an extra skills root recursively and follows links. A skill
 * folder in a checkout can therefore hold a link to the user's own skills or a
 * second skill nested inside it, and Codex would load both. The first test
 * shows that this happens when the folder is staged as it is. The second shows
 * that the runner refuses such a folder, so nothing of it reaches Codex.
 *
 * The test is skipped when no `codex` binary is found. `HERCULE_CODEX_TEST_BINARY`
 * selects a binary without changing PATH. Codex runs with a scratch `CODEX_HOME`
 * and `HOME`, so it has no login and never reads the user's own folders.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import { listRepositorySkills } from "./repository";
import { stageRepositorySkills } from "./repository-staging";

const binary = process.env["HERCULE_CODEX_TEST_BINARY"] ?? Bun.which("codex") ?? undefined;

const roots: Array<string> = [];

afterAll(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const writeSkill = (parent: string, name: string): void => {
  mkdirSync(join(parent, name), { recursive: true });
  writeFileSync(
    join(parent, name, "SKILL.md"),
    `---\nname: ${name}\ndescription: The ${name} skill.\n---\nBody.\n`,
  );
};

/** The scratch folders of one test: a checkout holding a hostile skill, and the user's own skills. */
const buildScenario = () => {
  // Resolved, because macOS keeps temporary files under `/var`, a link to `/private/var`.
  const base = realpathSync(mkdtempSync(join(tmpdir(), "hercule-codex-containment-")));
  roots.push(base);
  const userSkills = join(base, "user", ".claude", "skills");
  writeSkill(userSkills, "user-secret-skill");
  const checkout = join(base, "checkout");
  const skillsFolder = join(checkout, ".agents", "skills");
  writeSkill(skillsFolder, "deploy");
  // A link out of the checkout and a second skill, both inside the accepted skill folder.
  symlinkSync(userSkills, join(skillsFolder, "deploy", "refs"));
  writeSkill(join(skillsFolder, "deploy", "nested"), "hidden-nested");
  const home = join(base, "codex-home");
  const userHome = join(base, "home");
  const cwd = join(base, "cwd");
  for (const folder of [home, userHome, cwd]) mkdirSync(folder);
  return { base, checkout, skillsFolder, home, userHome, cwd };
};

/** The `result` of one app-server response that the test reads: the skills Codex found, per folder. */
interface SkillsListResponse {
  readonly result: {
    readonly data: ReadonlyArray<{ readonly skills: ReadonlyArray<{ readonly name: string }> }>;
  };
}

/** Asks a Codex app-server, started on `scenario`, to list the skills it sees in `extraRoot`. */
const listSkillsCodexSees = async (
  scenario: ReturnType<typeof buildScenario>,
  extraRoot: string,
): Promise<ReadonlyArray<string>> => {
  const child = Bun.spawn([binary!, "app-server"], {
    cwd: scenario.cwd,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "ignore",
    env: { PATH: process.env["PATH"] ?? "", CODEX_HOME: scenario.home, HOME: scenario.userHome },
  });
  const send = (frame: unknown): void => {
    void child.stdin.write(`${JSON.stringify(frame)}\n`);
    void child.stdin.flush();
  };
  const reader = child.stdout.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  /** Reads lines until the response with `id` arrives. Codex logs and notifications are skipped. */
  const call = async (id: number, method: string, params: unknown): Promise<unknown> => {
    send({ id, method, params });
    for (;;) {
      const newline = buffered.indexOf("\n");
      if (newline < 0) {
        const chunk = await reader.read();
        if (chunk.done) throw new Error(`codex exited before it answered ${method}`);
        buffered += decoder.decode(chunk.value);
        continue;
      }
      const line = buffered.slice(0, newline);
      buffered = buffered.slice(newline + 1);
      try {
        const frame: unknown = JSON.parse(line);
        if (typeof frame === "object" && frame !== null && "id" in frame && frame.id === id) {
          return frame;
        }
      } catch {
        // Not a JSON line, so not part of the protocol.
      }
    }
  };
  try {
    await call(1, "initialize", {
      clientInfo: { name: "hercule-test", title: "hercule-test", version: "0" },
      capabilities: { experimentalApi: false, requestAttestation: false },
    });
    send({ method: "initialized" });
    await call(2, "skills/extraRoots/set", { extraRoots: [extraRoot] });
    const listed = (await call(3, "skills/list", {
      cwds: [scenario.cwd],
      forceReload: true,
    })) as SkillsListResponse;
    return listed.result.data.flatMap((entry) => entry.skills.map((skill) => skill.name)).sort();
  } finally {
    child.kill();
  }
};

describe.skipIf(binary === undefined)("repository skills in a real Codex app-server", () => {
  it("loads the nested skill and the linked user skill when the folder is staged unchecked", async () => {
    const scenario = buildScenario();
    const staged = join(scenario.base, "unchecked", "skills");
    mkdirSync(staged, { recursive: true });
    symlinkSync(join(scenario.skillsFolder, "deploy"), join(staged, "deploy"));

    const names = await listSkillsCodexSees(scenario, staged);

    expect(names).toContain("deploy");
    expect(names).toContain("hidden-nested");
    expect(names).toContain("user-secret-skill");
  }, 60_000);

  it("shows neither of them once the runner has refused the folder", async () => {
    const scenario = buildScenario();
    writeSkill(join(scenario.checkout, ".agents", "skills"), "safe");

    const listing = await Effect.runPromise(
      listRepositorySkills([
        { remote: "github.com/acme/api", subdirectory: null, path: scenario.checkout },
      ]),
    );
    expect(listing.skills.map((skill) => skill.name)).toEqual(["safe"]);
    expect(listing.skipped.map((entry) => entry.path)).toEqual([".agents/skills/deploy"]);

    const [pluginFolder] = await Effect.runPromise(
      stageRepositorySkills(join(scenario.base, "session"), listing.skills),
    );
    const names = await listSkillsCodexSees(scenario, join(pluginFolder!, "skills"));

    expect(names).toContain("safe");
    expect(names).not.toContain("deploy");
    expect(names).not.toContain("hidden-nested");
    expect(names).not.toContain("user-secret-skill");
  }, 60_000);
});
