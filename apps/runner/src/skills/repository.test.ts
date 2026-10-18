/**
 * Tests that the runner lists the repository skills of a workspace from the
 * folders of its checkouts, on a temporary directory.
 */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import { listRepositorySkills } from "./repository";

const roots: Array<string> = [];

afterAll(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const makeRoot = (): string => {
  const root = mkdtempSync(join(tmpdir(), "hercule-repository-skills-"));
  roots.push(root);
  return root;
};

/** Writes `<checkout>/<folder>/<name>/SKILL.md` with the given frontmatter lines. */
const writeSkill = (checkout: string, folder: string, name: string, frontmatter: string): void => {
  const file = join(checkout, folder, name, "SKILL.md");
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `---\n${frontmatter}\n---\n\n# ${name}\n`);
};

/** Builds a checkout the way the registry records it, in `subdirectory` of `root` or at the root. */
const checkoutIn = (root: string, subdirectory: string | null, remote: string) => ({
  checkoutId: `checkout-${subdirectory ?? "root"}`,
  remote,
  path: subdirectory === null ? root : join(root, subdirectory),
});

const list = (workspace: Parameters<typeof listRepositorySkills>[0]) =>
  Effect.runPromise(listRepositorySkills(workspace));

describe("listRepositorySkills", () => {
  it("names the skills of each checkout by the checkout, so equal skill names do not clash", async () => {
    const root = makeRoot();
    writeSkill(join(root, "api"), ".agents/skills", "release", "description: Ships the API");
    writeSkill(join(root, "web"), ".claude/skills", "release", "description: Ships the web app");

    const { skills, skipped } = await list({
      root,
      checkouts: [
        checkoutIn(root, "api", "github.com/acme/api"),
        checkoutIn(root, "web", "github.com/acme/web"),
      ],
    });

    expect(skipped).toEqual([]);
    expect(
      skills.map(({ checkoutName, name, path, absolutePath }) => ({
        checkoutName,
        name,
        path,
        absolutePath,
      })),
    ).toEqual([
      {
        checkoutName: "api",
        name: "release",
        path: ".agents/skills/release",
        absolutePath: join(root, "api/.agents/skills/release"),
      },
      {
        checkoutName: "web",
        name: "release",
        path: ".claude/skills/release",
        absolutePath: join(root, "web/.claude/skills/release"),
      },
    ]);
    expect(skills.map((skill) => skill.description)).toEqual([
      "Ships the API",
      "Ships the web app",
    ]);
  });

  it("names a checkout at the workspace root after the repo of its remote", async () => {
    const root = makeRoot();
    writeSkill(root, ".agents/skills", "release", "description: Ships it");

    const { skills } = await list({
      root,
      checkouts: [checkoutIn(root, null, "https://github.com/theagenticage/hercule.git")],
    });

    expect(skills.map((skill) => `${skill.checkoutName}:${skill.name}`)).toEqual([
      "hercule:release",
    ]);
  });

  it("prefers the .agents/skills folder when both folders hold the same name", async () => {
    const root = makeRoot();
    writeSkill(root, ".claude/skills", "release", "description: From claude");
    writeSkill(root, ".claude/skills", "build", "description: Builds");
    writeSkill(root, ".agents/skills", "release", "description: From agents");

    const { skills, skipped } = await list({
      root,
      checkouts: [checkoutIn(root, null, "github.com/acme/app")],
    });

    expect(skills.map((skill) => [skill.name, skill.path, skill.description])).toEqual([
      ["build", ".claude/skills/build", "Builds"],
      ["release", ".agents/skills/release", "From agents"],
    ]);
    expect(skipped).toEqual([
      {
        path: ".claude/skills/release",
        reason: "`.agents/skills/release` has the same name",
      },
    ]);
  });

  it("lists a skill once when .claude/skills links to .agents/skills", async () => {
    const root = makeRoot();
    writeSkill(root, ".agents/skills", "release", "description: Ships it");
    mkdirSync(join(root, ".claude"));
    symlinkSync(join(root, ".agents/skills"), join(root, ".claude/skills"));

    const { skills, skipped } = await list({
      root,
      checkouts: [checkoutIn(root, null, "github.com/acme/app")],
    });

    expect(skills.map((skill) => skill.path)).toEqual([".agents/skills/release"]);
    expect(skipped).toEqual([]);
  });

  it("skips a folder that is not a skill, with the reason", async () => {
    const root = makeRoot();
    const folder = ".agents/skills";
    writeSkill(root, folder, "Bad_Name", "description: Not a valid name");
    writeSkill(root, folder, "no-description", "name: no-description");
    writeSkill(root, folder, "too-long", `description: ${"x".repeat(1025)}`);
    writeSkill(root, folder, "broken-yaml", "description: [unclosed");
    mkdirSync(join(root, folder, "no-file"), { recursive: true });
    writeSkill(root, folder, "good", "description: Works");

    const { skills, skipped } = await list({
      root,
      checkouts: [checkoutIn(root, null, "github.com/acme/app")],
    });

    expect(skills.map((skill) => skill.name)).toEqual(["good"]);
    const reasons = Object.fromEntries(skipped.map((entry) => [entry.path, entry.reason]));
    expect(Object.keys(reasons).sort()).toEqual([
      ".agents/skills/Bad_Name",
      ".agents/skills/broken-yaml",
      ".agents/skills/no-description",
      ".agents/skills/no-file",
      ".agents/skills/too-long",
    ]);
    expect(reasons[".agents/skills/Bad_Name"]).toContain("not a valid skill name");
    expect(reasons[".agents/skills/broken-yaml"]).toContain("not valid YAML");
    expect(reasons[".agents/skills/no-description"]).toContain("no description");
    expect(reasons[".agents/skills/no-file"]).toContain("has no SKILL.md");
    expect(reasons[".agents/skills/too-long"]).toContain("1025 characters");
  });

  it("skips every skill of a checkout whose prefix an earlier checkout already has", async () => {
    const root = makeRoot();
    writeSkill(join(root, "foo.js"), ".agents/skills", "release", "description: First");
    writeSkill(join(root, "foo-js"), ".agents/skills", "release", "description: Second");

    const { skills, skipped } = await list({
      root,
      checkouts: [
        checkoutIn(root, "foo.js", "github.com/acme/foo.js"),
        checkoutIn(root, "foo-js", "github.com/acme/foo-js"),
      ],
    });

    expect(skills.map((skill) => [skill.checkoutName, skill.description])).toEqual([
      ["foo-js", "First"],
    ]);
    expect(skipped).toEqual([
      {
        path: "foo-js/.agents/skills/release",
        reason: "checkout `foo-js` has the same skill prefix as another checkout in this workspace",
      },
    ]);
  });

  it("skips a skill whose frontmatter name differs from its folder name, and accepts one without a name", async () => {
    const root = makeRoot();
    writeSkill(root, ".agents/skills", "renamed", "name: other-name\ndescription: Differs");
    writeSkill(root, ".agents/skills", "matching", "name: matching\ndescription: Same name");
    writeSkill(root, ".agents/skills", "unnamed", "description: No name");

    const { skills, skipped } = await list({
      root,
      checkouts: [checkoutIn(root, null, "github.com/acme/app")],
    });

    expect(skills.map((skill) => skill.name)).toEqual(["matching", "unnamed"]);
    expect(skipped).toEqual([
      {
        path: ".agents/skills/renamed",
        reason:
          "`.agents/skills/renamed`: its frontmatter name `other-name` differs from its folder name `renamed`; the Agent Skills format requires them to match",
      },
    ]);
  });

  it("names a skipped folder by its path from the workspace root in a multi-checkout workspace", async () => {
    const root = makeRoot();
    writeSkill(join(root, "web"), ".agents/skills", "My_Skill", "description: Bad name");
    writeSkill(join(root, "api"), ".agents/skills", "release", "description: Ships");

    const { skills, skipped } = await list({
      root,
      checkouts: [
        checkoutIn(root, "api", "github.com/acme/api"),
        checkoutIn(root, "web", "github.com/acme/web"),
      ],
    });

    expect(skills.map((skill) => skill.path)).toEqual([".agents/skills/release"]);
    expect(skipped).toHaveLength(1);
    expect(skipped[0]?.path).toBe("web/.agents/skills/My_Skill");
    expect(skipped[0]?.reason).toMatch(
      /^`web\/\.agents\/skills\/My_Skill` is not a valid skill name/,
    );
  });

  it("fails only when the workspace directory itself cannot be read", async () => {
    const root = makeRoot();
    const missing = join(root, "gone");

    await expect(
      list({ root: missing, checkouts: [checkoutIn(missing, null, "github.com/acme/app")] }),
    ).rejects.toThrow("the workspace directory cannot be read");
    await expect(
      list({ root, checkouts: [checkoutIn(root, null, "github.com/acme/app")] }),
    ).resolves.toEqual({ skills: [], skipped: [] });
  });
});
