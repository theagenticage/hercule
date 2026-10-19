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
import { listRepositorySkills, listWorkspaceRepositorySkills } from "./repository";

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

const list = (workspace: Parameters<typeof listWorkspaceRepositorySkills>[0]) =>
  Effect.runPromise(listWorkspaceRepositorySkills(workspace));

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
      {
        path: ".agents/skills/readme",
        reason: "`.agents/skills/readme` is a link to a file, not to a folder",
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

    const { skills, skipped, truncated } = await list({
      root,
      checkouts: [checkoutIn(root, null, "github.com/acme/app")],
    });

    expect(skills).toHaveLength(MAX_REPOSITORY_SKILLS);
    expect(skipped).toHaveLength(MAX_REPOSITORY_SKILLS);
    expect(skipped[0]?.reason).toBe("this workspace already offers 256 skills");
    expect(truncated).toBe(true);
  });

  it("is not truncated when a list is exactly full, and is when one entry more is left out", async () => {
    const listCheckoutWith = async (skillCount: number, skippedCount: number) => {
      const root = makeRoot();
      for (let index = 0; index < skillCount; index++) {
        writeSkill(
          root,
          ".agents/skills",
          `skill-${String(index).padStart(3, "0")}`,
          "description: A",
        );
      }
      for (let index = 0; index < skippedCount; index++) {
        mkdirSync(join(root, ".claude/skills", `Bad_${String(index)}`), { recursive: true });
      }
      const listing = await list({
        root,
        checkouts: [checkoutIn(root, null, "github.com/acme/app")],
      });
      return listing;
    };

    const fullSkills = await listCheckoutWith(MAX_REPOSITORY_SKILLS, 0);
    expect(fullSkills.skills).toHaveLength(MAX_REPOSITORY_SKILLS);
    expect(fullSkills.truncated).toBe(false);

    const tooManySkills = await listCheckoutWith(MAX_REPOSITORY_SKILLS + 1, 0);
    expect(tooManySkills.skills).toHaveLength(MAX_REPOSITORY_SKILLS);
    expect(tooManySkills.truncated).toBe(true);

    const fullSkipped = await listCheckoutWith(0, MAX_REPOSITORY_SKILLS);
    expect(fullSkipped.skipped).toHaveLength(MAX_REPOSITORY_SKILLS);
    expect(fullSkipped.truncated).toBe(false);

    const tooManySkipped = await listCheckoutWith(0, MAX_REPOSITORY_SKILLS + 1);
    expect(tooManySkipped.skipped).toHaveLength(MAX_REPOSITORY_SKILLS);
    expect(tooManySkipped.truncated).toBe(true);
  });

  it("is not truncated when both lists are full and a later checkout adds nothing", async () => {
    const root = makeRoot();
    for (let index = 0; index < MAX_REPOSITORY_SKILLS; index++) {
      writeSkill(
        join(root, "api"),
        ".agents/skills",
        `skill-${String(index).padStart(3, "0")}`,
        "description: A",
      );
    }
    for (let index = 0; index < MAX_REPOSITORY_SKILLS; index++) {
      mkdirSync(join(root, "api", ".claude/skills", `Bad_${String(index)}`), { recursive: true });
    }
    mkdirSync(join(root, "web"));

    const { skills, skipped, truncated } = await list({
      root,
      checkouts: [
        checkoutIn(root, "api", "github.com/acme/api"),
        checkoutIn(root, "web", "github.com/acme/web"),
      ],
    });

    expect(skills).toHaveLength(MAX_REPOSITORY_SKILLS);
    expect(skipped).toHaveLength(MAX_REPOSITORY_SKILLS);
    expect(truncated).toBe(false);
  });

  it("says the list is cut only when the limits cut it", async () => {
    const root = makeRoot();
    writeSkill(root, ".agents/skills", "release", "description: Ships it");

    const listing = await list({
      root,
      checkouts: [checkoutIn(root, null, "github.com/acme/app")],
    });

    expect(listing.truncated).toBe(false);
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
        listWorkspaceRepositorySkills({
          root: missing,
          checkouts: [checkoutIn(missing, null, "github.com/acme/app")],
        }),
      ),
    );
    expect(failure).toMatch(/^the workspace folder cannot be read: ENOENT/);
    expect(failure).not.toContain(root);
    await expect(
      list({ root, checkouts: [checkoutIn(root, null, "github.com/acme/app")] }),
    ).resolves.toEqual({ skills: [], skipped: [], truncated: false });
  });
});

describe("listRepositorySkills frontmatter", () => {
  const listOne = async (frontmatter: string) => {
    const root = makeRoot();
    writeSkill(root, ".agents/skills", "app", frontmatter);
    return list({ root, checkouts: [checkoutIn(root, null, "github.com/acme/app")] });
  };

  it("refuses a frontmatter name that is not text, because Claude Code would load another name", async () => {
    for (const [frontmatter, kind] of [
      ["name: 123\ndescription: A", "a number"],
      ["name: true\ndescription: A", "true or false"],
      ["name:\ndescription: A", "empty"],
      ["name: [a, b]\ndescription: A", "a list"],
      ["name: {a: b}\ndescription: A", "a mapping"],
    ] as const) {
      const { skills, skipped } = await listOne(frontmatter);
      expect(skills).toEqual([]);
      expect(skipped).toEqual([
        {
          path: ".agents/skills/app",
          reason: `\`.agents/skills/app\`: its frontmatter name is ${kind}, not text; write it as text`,
        },
      ]);
    }
  });

  it("refuses a description with a control character, and keeps one written over several lines", async () => {
    for (const bad of ["a\\u0001b", "a\\u0085b", "a\\u202Eb", "a\\u007Fb"]) {
      const { skills, skipped } = await listOne(`description: "${bad}"`);
      expect(skills).toEqual([]);
      expect(skipped[0]?.reason).toBe(
        "`.agents/skills/app`: its description has a control character",
      );
    }
    const { skills, skipped } = await listOne("description: |\n  Line one\n  Line two\tend");
    expect(skipped).toEqual([]);
    expect(skills.map((skill) => skill.description)).toEqual(["Line one\nLine two\tend"]);
  });

  it("says a frontmatter longer than 64 KiB is too long, not that it is missing", async () => {
    const { skipped } = await listOne(`description: A\npadding: ${"x".repeat(70 * 1024)}`);
    expect(skipped).toEqual([
      {
        path: ".agents/skills/app",
        reason: "`.agents/skills/app`: its frontmatter is longer than 64 KiB",
      },
    ]);
  });

  it("still says the frontmatter is missing for a short file without it", async () => {
    const root = makeRoot();
    mkdirSync(join(root, ".agents/skills/app"), { recursive: true });
    writeFileSync(join(root, ".agents/skills/app/SKILL.md"), "# no frontmatter\n");
    const { skipped } = await list({
      root,
      checkouts: [checkoutIn(root, null, "github.com/acme/app")],
    });
    expect(skipped[0]?.reason).toContain("no frontmatter between two `---` lines");
  });
});

describe("listRepositorySkills reports a folder once", () => {
  it("reports a broken skill and a badly named folder once when .claude/skills links to .agents/skills", async () => {
    const root = makeRoot();
    writeSkill(root, ".agents/skills", "broken", "name: broken");
    mkdirSync(join(root, ".agents/skills/Bad_Name"), { recursive: true });
    mkdirSync(join(root, ".claude"));
    symlinkSync("../.agents/skills", join(root, ".claude/skills"));

    const { skills, skipped } = await list({
      root,
      checkouts: [checkoutIn(root, null, "github.com/acme/app")],
    });

    expect(skills).toEqual([]);
    expect(skipped.map((entry) => entry.path)).toEqual([
      ".agents/skills/Bad_Name",
      ".agents/skills/broken",
    ]);
  });

  it("reports a skill folder once when two single links lead to it", async () => {
    const root = makeRoot();
    writeSkill(root, ".agents/skills", "broken", "name: broken");
    mkdirSync(join(root, ".claude/skills"), { recursive: true });
    symlinkSync("../../.agents/skills/broken", join(root, ".claude/skills/broken"));

    const { skipped } = await list({
      root,
      checkouts: [checkoutIn(root, null, "github.com/acme/app")],
    });

    expect(skipped.map((entry) => entry.path)).toEqual([".agents/skills/broken"]);
  });

  it("ignores a plain file and a link to a file whose name is not a skill name", async () => {
    const root = makeRoot();
    mkdirSync(join(root, ".agents/skills"), { recursive: true });
    writeFileSync(join(root, ".agents/skills/README.md"), "not a skill");
    symlinkSync("../../README.md", join(root, ".agents/skills/Notes.md"));
    writeFileSync(join(root, "README.md"), "x");

    const { skills, skipped } = await list({
      root,
      checkouts: [checkoutIn(root, null, "github.com/acme/app")],
    });

    expect({ skills, skipped }).toEqual({ skills: [], skipped: [] });
  });
});

describe("listRepositorySkills inside a skill folder", () => {
  const listApp = async (root: string) => {
    return list({ root, checkouts: [checkoutIn(root, null, "github.com/acme/app")] });
  };

  it("refuses a skill that holds a link out of the checkout, so a harness cannot load what is behind it", async () => {
    const root = makeRoot();
    const outside = makeRoot();
    writeSkill(
      join(outside, ".claude"),
      "skills",
      "user-secret-skill",
      "description: The user's own",
    );
    writeSkill(root, ".agents/skills", "deploy", "description: Deploys");
    symlinkSync(join(outside, ".claude/skills"), join(root, ".agents/skills/deploy/refs"));
    writeSkill(root, ".agents/skills", "kept", "description: Fine");

    const { skills, skipped } = await listApp(root);

    expect(skills.map((skill) => skill.name)).toEqual(["kept"]);
    expect(skipped).toEqual([
      {
        path: ".agents/skills/deploy",
        reason:
          "`.agents/skills/deploy`: its folder holds the link `refs`, which leads outside its checkout",
      },
    ]);
    expect(JSON.stringify(skipped)).not.toContain(outside);
  });

  it("refuses a skill that holds another skill at any depth", async () => {
    const root = makeRoot();
    writeSkill(root, ".agents/skills", "deploy", "description: Deploys");
    writeSkill(join(root, ".agents/skills/deploy/x"), "hidden", "hidden-nested", "description: H");
    writeSkill(root, ".agents/skills", "other", "description: Other");
    mkdirSync(join(root, ".agents/skills/other/docs"));
    writeFileSync(join(root, ".agents/skills/other/docs/Skill.MD"), "x");

    const { skills, skipped } = await listApp(root);

    expect(skills).toEqual([]);
    expect(skipped.map((entry) => [entry.path, entry.reason])).toEqual([
      [
        ".agents/skills/deploy",
        "`.agents/skills/deploy`: its folder holds a second skill, `x/hidden/hidden-nested/SKILL.md`",
      ],
      [
        ".agents/skills/other",
        "`.agents/skills/other`: its folder holds a second skill, `docs/Skill.MD`",
      ],
    ]);
  });

  it("follows a link inside the checkout, because a harness does, and refuses what it leads to", async () => {
    const root = makeRoot();
    writeSkill(root, ".agents/skills", "deploy", "description: Deploys");
    writeSkill(root, ".agents/skills", "sibling", "description: Sibling");
    symlinkSync("../sibling", join(root, ".agents/skills/deploy/more"));
    writeFileSync(join(root, "shared.md"), "shared");
    symlinkSync("../../../shared.md", join(root, ".agents/skills/sibling/shared.md"));

    const { skills, skipped } = await listApp(root);

    expect(skills.map((skill) => skill.name)).toEqual(["sibling"]);
    expect(skipped.map((entry) => entry.reason)).toEqual([
      "`.agents/skills/deploy`: its folder holds a second skill, `more/SKILL.md`",
    ]);
  });

  it("refuses a link that cannot be followed, and survives a link loop inside the skill", async () => {
    const root = makeRoot();
    writeSkill(root, ".agents/skills", "dangling", "description: D");
    symlinkSync("gone", join(root, ".agents/skills/dangling/ref"));
    writeSkill(root, ".agents/skills", "looping", "description: L");
    symlinkSync(".", join(root, ".agents/skills/looping/self"));

    const { skills, skipped } = await listApp(root);

    expect(skills.map((skill) => skill.name)).toEqual(["looping"]);
    expect(skipped).toHaveLength(1);
    expect(skipped[0]?.reason).toMatch(
      /^`\.agents\/skills\/dangling`: its folder holds the link `ref`, which cannot be followed: ENOENT/,
    );
  });
});

describe("listRepositorySkills checkouts", () => {
  const run = (checkouts: Parameters<typeof listRepositorySkills>[0]) =>
    Effect.runPromise(listRepositorySkills(checkouts));

  it("lists the skills of a checkout named by the subdirectory it is given", async () => {
    const folder = makeRoot();
    writeSkill(folder, ".claude/skills", "release", "description: Ships it");

    const { skills, skipped, truncated } = await run([
      { remote: "github.com/acme/api", subdirectory: "api", path: folder },
    ]);

    expect({ skipped, truncated }).toEqual({ skipped: [], truncated: false });
    expect(skills.map((skill) => [skill.checkoutName, skill.path])).toEqual([
      ["api", "api/.claude/skills/release"],
    ]);
  });

  it("reports a checkout with no folder, and one whose folder is gone, and keeps their prefixes", async () => {
    const present = makeRoot();
    writeSkill(present, ".agents/skills", "release", "description: Ships it");
    const gone = join(makeRoot(), "gone");

    const { skills, skipped } = await run([
      { remote: "github.com/acme/api", subdirectory: "api", path: null },
      { remote: "github.com/acme/web", subdirectory: "web", path: gone },
      // Has the prefix `api` too: the checkout above reserved it, though it offers nothing.
      { remote: "github.com/acme/api", subdirectory: "api", path: present },
      { remote: "github.com/acme/app", subdirectory: null, path: null },
    ]);

    expect(skills).toEqual([]);
    expect(skipped.map((entry) => [entry.path, entry.reason])).toEqual([
      ["api", "the repo has no ready main workspace on this runner"],
      ["web", expect.stringMatching(/^the checkout folder cannot be read: ENOENT/)],
      [
        "api/.agents/skills/release",
        "checkout `api` has the same skill prefix as another checkout in this workspace",
      ],
      [".", "the repo has no ready main workspace on this runner"],
    ]);
    expect(JSON.stringify(skipped)).not.toContain(gone);
  });

  it("counts a checkout that cannot be read against the limit of skipped entries", async () => {
    const checkouts = Array.from({ length: MAX_REPOSITORY_SKILLS + 1 }, (_, index) => ({
      remote: `github.com/acme/repo-${String(index)}`,
      subdirectory: `repo-${String(index)}`,
      path: null,
    }));

    const { skipped, truncated } = await run(checkouts);

    expect(skipped).toHaveLength(MAX_REPOSITORY_SKILLS);
    expect(truncated).toBe(true);
  });
});
