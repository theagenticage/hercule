/**
 * Tests that the runner lists the repository skills of a workspace from the
 * folders of its checkouts, on a temporary directory.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import {
  MAX_FACT_LENGTH,
  MAX_REPOSITORY_SKILLS,
  MAX_SKIPPED_REASON_LENGTH,
} from "@hercule/protocol";
import { listRepositorySkills } from "./repository";

const roots: Array<string> = [];

afterAll(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const makeRoot = (): string => {
  // Resolved, because macOS keeps temporary files under `/var`, a link to `/private/var`.
  const root = realpathSync(mkdtempSync(join(tmpdir(), "hercule-repository-skills-")));
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
        path: "api/.agents/skills/release",
        absolutePath: join(root, "api/.agents/skills/release"),
      },
      {
        checkoutName: "web",
        name: "release",
        path: "web/.claude/skills/release",
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

    expect(skills.map((skill) => skill.path)).toEqual(["api/.agents/skills/release"]);
    expect(skipped).toHaveLength(1);
    expect(skipped[0]?.path).toBe("web/.agents/skills/My_Skill");
    expect(skipped[0]?.reason).toMatch(
      /^`web\/\.agents\/skills\/My_Skill` is not a valid skill name/,
    );
  });

  it("lists each skill once when .claude/skills is a relative link, and when single skills are linked", async () => {
    const root = makeRoot();
    writeSkill(root, ".agents/skills", "release", "description: Ships it");
    writeSkill(root, ".agents/skills", "build", "description: Builds");
    mkdirSync(join(root, ".claude"));
    symlinkSync("../.agents/skills", join(root, ".claude/skills"));
    const other = makeRoot();
    writeSkill(other, ".agents/skills", "release", "description: Ships it");
    mkdirSync(join(other, ".claude/skills"), { recursive: true });
    symlinkSync("../../.agents/skills/release", join(other, ".claude/skills/release"));

    for (const checkoutRoot of [root, other]) {
      const { skills, skipped } = await list({
        root: checkoutRoot,
        checkouts: [checkoutIn(checkoutRoot, null, "github.com/acme/app")],
      });
      expect(skills.map((skill) => skill.path).filter((path) => path.includes("release"))).toEqual([
        ".agents/skills/release",
      ]);
      expect(skipped).toEqual([]);
    }
  });

  it("skips a .agents folder that is a link out of the checkout, so the user's own skills are not offered", async () => {
    const root = makeRoot();
    const outside = makeRoot();
    writeSkill(outside, "skills", "private", "description: The user's own skill");
    symlinkSync(outside, join(root, ".agents"));
    writeSkill(root, ".claude/skills", "kept", "description: Inside the checkout");

    const { skills, skipped } = await list({
      root,
      checkouts: [checkoutIn(root, null, "github.com/acme/app")],
    });

    expect(skills.map((skill) => skill.name)).toEqual(["kept"]);
    expect(skipped).toEqual([
      {
        path: ".agents/skills",
        reason: "`.agents/skills` is a link to a folder outside its checkout",
      },
    ]);
    expect(JSON.stringify(skipped)).not.toContain(outside);
  });

  it("skips a skill folder that is a link out of the checkout, and one that is a link to a file", async () => {
    const root = makeRoot();
    const outside = makeRoot();
    writeSkill(outside, "", "evil", "description: Not in the checkout");
    mkdirSync(join(root, ".agents/skills"), { recursive: true });
    symlinkSync(join(outside, "evil"), join(root, ".agents/skills/evil"));
    writeFileSync(join(root, "README.md"), "not a skill");
    symlinkSync("../../README.md", join(root, ".agents/skills/readme"));
    writeSkill(root, ".agents/skills", "good", "description: Works");

    const { skills, skipped } = await list({
      root,
      checkouts: [checkoutIn(root, null, "github.com/acme/app")],
    });

    expect(skills.map((skill) => skill.name)).toEqual(["good"]);
    expect(skipped).toEqual([
      {
        path: ".agents/skills/evil",
        reason: "`.agents/skills/evil` is a link to a folder outside its checkout",
      },
    ]);
  });

  it("skips a SKILL.md that is a link out of the checkout, and one that is a named pipe", async () => {
    const root = makeRoot();
    const outside = makeRoot();
    writeFileSync(join(outside, "SKILL.md"), "---\ndescription: Elsewhere\n---\n");
    mkdirSync(join(root, ".agents/skills/linked"), { recursive: true });
    symlinkSync(join(outside, "SKILL.md"), join(root, ".agents/skills/linked/SKILL.md"));
    mkdirSync(join(root, ".agents/skills/piped"), { recursive: true });
    Bun.spawnSync(["mkfifo", join(root, ".agents/skills/piped/SKILL.md")]);

    const { skills, skipped } = await list({
      root,
      checkouts: [checkoutIn(root, null, "github.com/acme/app")],
    });

    expect(skills).toEqual([]);
    expect(skipped).toEqual([
      {
        path: ".agents/skills/linked",
        reason: "`.agents/skills/linked`: its SKILL.md is a link to a file outside its checkout",
      },
      {
        path: ".agents/skills/piped",
        reason: "`.agents/skills/piped`: its SKILL.md is not a regular file",
      },
    ]);
  });

  it("lists a skill that a link with a rejected name points at", async () => {
    const root = makeRoot();
    writeSkill(root, ".agents/skills", "zzz", "name: zzz\ndescription: The real one");
    symlinkSync("zzz", join(root, ".agents/skills/Aaa"));
    symlinkSync("zzz", join(root, ".agents/skills/bbb"));

    const { skills, skipped } = await list({
      root,
      checkouts: [checkoutIn(root, null, "github.com/acme/app")],
    });

    expect(skills.map((skill) => skill.name)).toEqual(["zzz"]);
    expect(skipped.map((entry) => entry.path)).toEqual([
      ".agents/skills/Aaa",
      ".agents/skills/bbb",
    ]);
    expect(skipped[0]?.reason).toContain("not a valid skill name");
    expect(skipped[1]?.reason).toContain("differs from its folder name");
  });

  it("keeps a reason short and free of control characters when the repository makes a name huge", async () => {
    const root = makeRoot();
    writeSkill(
      root,
      ".agents/skills",
      "big",
      `name: "${"x".repeat(5000)}\\nsecond line"\ndescription: Too big`,
    );
    mkdirSync(join(root, ".agents/skills", `Bad\nName${"y".repeat(200)}`), { recursive: true });

    const { skills, skipped } = await list({
      root,
      checkouts: [checkoutIn(root, null, "github.com/acme/app")],
    });

    expect(skills).toEqual([]);
    expect(skipped).toHaveLength(2);
    for (const entry of skipped) {
      expect(entry.reason.length).toBeLessThanOrEqual(MAX_SKIPPED_REASON_LENGTH);
      expect(entry.path.length).toBeLessThanOrEqual(MAX_FACT_LENGTH);
      expect(entry.reason + entry.path).not.toMatch(/\p{Cc}/u);
    }
    expect(skipped.find((entry) => entry.path.includes("big"))?.reason).toContain(
      `${"x".repeat(64)}...`,
    );
    expect(skipped.find((entry) => entry.path.includes("Bad"))?.path).toContain("Bad\\u{a}Name");
  });

  it("stops at the limits: 256 skills and 256 skipped folders", async () => {
    const root = makeRoot();
    for (let index = 0; index < 300; index++) {
      writeSkill(
        root,
        ".agents/skills",
        `skill-${String(index).padStart(3, "0")}`,
        "description: A",
      );
    }
    for (let index = 0; index < 400; index++) {
      mkdirSync(join(root, ".claude/skills", `Bad_${String(index)}`), { recursive: true });
    }

    const { skills, skipped } = await list({
      root,
      checkouts: [checkoutIn(root, null, "github.com/acme/app")],
    });

    expect(skills).toHaveLength(MAX_REPOSITORY_SKILLS);
    expect(skipped).toHaveLength(MAX_REPOSITORY_SKILLS);
    expect(skipped[0]?.reason).toBe("this workspace already offers 256 skills");
  });

  it("names paths from the real workspace root when the root is given through a link", async () => {
    const real = makeRoot();
    writeSkill(join(real, "web"), ".agents/skills", "release", "description: Ships");
    const alias = join(makeRoot(), "alias");
    symlinkSync(real, alias);

    const { skills } = await list({
      root: alias,
      checkouts: [checkoutIn(real, "web", "github.com/acme/web")],
    });

    expect(skills.map((skill) => skill.path)).toEqual(["web/.agents/skills/release"]);
  });

  it("fails only when the workspace directory itself cannot be read", async () => {
    const root = makeRoot();
    const missing = join(root, "gone");

    const failure = await Effect.runPromise(
      Effect.flip(
        listRepositorySkills({
          root: missing,
          checkouts: [checkoutIn(missing, null, "github.com/acme/app")],
        }),
      ),
    );
    expect(failure).toMatch(/^the workspace folder cannot be read: ENOENT/);
    expect(failure).not.toContain(root);
    await expect(
      list({ root, checkouts: [checkoutIn(root, null, "github.com/acme/app")] }),
    ).resolves.toEqual({ skills: [], skipped: [] });
  });
});
