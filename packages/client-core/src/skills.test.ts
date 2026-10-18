import { describe, expect, it } from "vitest";
import type { Skill, SkillDetail, SkillImportInput, SkillRevision } from "@hercule/contract";
import type { HerculeClient } from "./client";
import { ApiError, ConnectionError } from "./errors";
import {
  buildSkillImportQuery,
  countSkillImportOutcomes,
  describeFolderWithoutSkills,
  describeLockedSkillSource,
  describeSkillRevisionApplied,
  describeSkillRevisionOrigin,
  describeSkillImportSummary,
  describeSkillSource,
  describeSkillSourceInFull,
  describeSkillTooLarge,
  findCurrentSkillRevision,
  findSkillMdSize,
  describeUploadFolderProblem,
  formatSkillSize,
  importSkillArchive,
  isExecutableSkillFile,
  isSkillImportRefusal,
  listSkillApprovalWarnings,
  splitAllowedTools,
  stripFrontmatter,
} from "./skills";

describe("listSkillApprovalWarnings", () => {
  it("returns no lines when the revision has no approval effects", () => {
    expect(listSkillApprovalWarnings("grilling", null)).toEqual([]);
    expect(listSkillApprovalWarnings("grilling", { allowedTools: null, hooks: null })).toEqual([]);
  });

  it("names the skill, then the allowed-tools value as one code span, then hooks", () => {
    expect(
      listSkillApprovalWarnings("grilling", { allowedTools: "Bash(git:*) Read", hooks: "{}" }),
    ).toEqual([
      "`grilling` lets tools run without asking: `Bash(git:*) Read`",
      "`grilling` has hooks, which run without asking",
    ]);
    expect(listSkillApprovalWarnings("grilling", { allowedTools: null, hooks: "{}" })).toEqual([
      "`grilling` has hooks, which run without asking",
    ]);
  });
});

describe("splitAllowedTools", () => {
  it("splits at spaces outside parentheses", () => {
    expect(splitAllowedTools("Bash(git tag:*) Read  Bash(npx:*)")).toEqual([
      "Bash(git tag:*)",
      "Read",
      "Bash(npx:*)",
    ]);
  });

  it("returns no rules for blank text", () => {
    expect(splitAllowedTools("  ")).toEqual([]);
  });
});

describe("formatSkillSize", () => {
  it("counts files and formats the bytes", () => {
    expect(formatSkillSize(2, 6656)).toBe("2 files · 6.5 KiB");
    expect(formatSkillSize(1, 812)).toBe("1 file · 812 B");
    expect(formatSkillSize(0, 0)).toBe("0 files · 0 B");
  });
});

const GITHUB = {
  kind: "github",
  repo: "mattpocock/skills",
  path: "skills/grilling",
  branch: null,
} as const;

describe("describeSkillSource", () => {
  it("names the repository of a GitHub source", () => {
    expect(describeSkillSource(GITHUB)).toBe("GitHub: mattpocock/skills");
  });

  it("calls an upload Uploaded", () => {
    expect(describeSkillSource({ kind: "upload" })).toBe("Uploaded");
  });
});

describe("describeSkillSourceInFull", () => {
  it("names the repository and the folder", () => {
    expect(describeSkillSourceInFull(GITHUB)).toBe("mattpocock/skills · skills/grilling");
  });

  it("adds a branch that is not the default one", () => {
    expect(describeSkillSourceInFull({ ...GITHUB, branch: "next" })).toBe(
      "mattpocock/skills · skills/grilling · branch next",
    );
  });

  it("calls an upload Uploaded", () => {
    expect(describeSkillSourceInFull({ kind: "upload" })).toBe("Uploaded");
  });
});

describe("stripFrontmatter", () => {
  it("drops the lines from the opening --- to the closing one", () => {
    expect(stripFrontmatter("---\nname: teach\ndescription: x\n---\n# Teach\n\nBody")).toBe(
      "# Teach\n\nBody",
    );
  });

  it("drops frontmatter written with Windows line ends", () => {
    expect(stripFrontmatter("---\r\nname: teach\r\n---\r\n# Teach")).toBe("# Teach");
  });

  it("keeps a text whose first line is not ---", () => {
    expect(stripFrontmatter("# Teach\n---\nname: x\n---")).toBe("# Teach\n---\nname: x\n---");
  });

  it("keeps a text whose frontmatter is never closed", () => {
    expect(stripFrontmatter("---\nname: teach\n# Teach")).toBe("---\nname: teach\n# Teach");
  });
});

describe("describeSkillRevisionOrigin", () => {
  it("names each origin as History does", () => {
    expect(describeSkillRevisionOrigin("import")).toBe("Imported");
    expect(describeSkillRevisionOrigin("github")).toBe("Updated from GitHub");
    expect(describeSkillRevisionOrigin("session")).toBe("Proposed by a session");
  });
});

describe("describeSkillRevisionApplied", () => {
  const now = new Date("2026-10-18T16:00:00Z");

  it("names the user and the time today", () => {
    expect(
      describeSkillRevisionApplied(
        { appliedAt: "2026-10-18T14:02:00Z", appliedBy: "user" },
        now,
        "UTC",
      ),
    ).toBe("applied by you, 14:02");
  });

  it("gives a date to a time more than a week ago", () => {
    expect(
      describeSkillRevisionApplied(
        { appliedAt: "2026-09-28T10:15:00Z", appliedBy: "user" },
        now,
        "UTC",
      ),
    ).toBe("applied by you, 28 Sep 10:15");
  });

  it("names a session by its id", () => {
    expect(
      describeSkillRevisionApplied(
        {
          appliedAt: "2026-10-18T14:02:00Z",
          appliedBy: "session:0199a3c2-7b41-7e2a-9c3d-5f1e2a8b4c60",
        },
        now,
        "UTC",
      ),
    ).toMatch(/^applied by session \S+, 14:02$/);
  });

  it("leaves out what is not known", () => {
    expect(describeSkillRevisionApplied({ appliedAt: null, appliedBy: "user" }, now, "UTC")).toBe(
      "applied by you",
    );
    expect(describeSkillRevisionApplied({ appliedAt: null, appliedBy: null }, now, "UTC")).toBe(
      "applied",
    );
  });
});

describe("describeSkillTooLarge", () => {
  it("names the skill and the most a skill can hold", () => {
    expect(describeSkillTooLarge("teach")).toBe(
      "`teach` is over 10 MiB, the most a skill can hold.",
    );
  });
});

describe("describeUploadFolderProblem", () => {
  const folder = (skillNames: ReadonlyArray<string>) => ({ displayPath: "~/skills", skillNames });

  it("accepts a folder that holds only the skill", () => {
    expect(describeUploadFolderProblem("teach", folder(["teach"]))).toBeNull();
  });

  it("names the other skill a folder holds", () => {
    expect(describeUploadFolderProblem("teach", folder(["teaching"]))).toBe(
      "The folder holds `teaching`, not `teach`.",
    );
  });

  it("counts the skills of a folder that holds several, even with the skill among them", () => {
    expect(describeUploadFolderProblem("teach", folder(["grilling", "teach", "triage"]))).toBe(
      "The folder holds 3 skills, not `teach`.",
    );
  });

  it("says that a folder holds no skill", () => {
    expect(describeUploadFolderProblem("teach", folder([]))).toBe(
      describeFolderWithoutSkills("~/skills"),
    );
    expect(describeFolderWithoutSkills("~/skills")).toBe(
      "No skills in `~/skills`. A skill is a folder that holds a `SKILL.md`.",
    );
  });
});

describe("describeSkillImportSummary", () => {
  it("counts imported, unchanged and refused skills", () => {
    expect(describeSkillImportSummary({ imported: 21, unchanged: 2, refused: 1, skipped: 0 })).toBe(
      "Imported 21, 2 unchanged, 1 refused",
    );
  });

  it("adds the skipped skills only when there are some", () => {
    expect(describeSkillImportSummary({ imported: 19, unchanged: 2, refused: 1, skipped: 2 })).toBe(
      "Imported 19, 2 unchanged, 1 refused, 2 skipped",
    );
  });
});

const SKILL: Skill = {
  name: "teach",
  source: { kind: "upload" },
  currentRevisionHash: "b".repeat(64),
  currentApprovalEffects: null,
  currentFileCount: 2,
  currentSizeBytes: 6656,
  availableRevisionHash: null,
  availableApprovalEffects: null,
  proposedCount: 0,
  lastCheckedAt: null,
  checkError: null,
  createdAt: "2026-10-18T10:00:00Z",
  createdBy: "user",
  updatedAt: "2026-10-18T14:02:00Z",
  updatedBy: "user",
};

describe("describeLockedSkillSource", () => {
  it("words a lock file's source as the list words a stored one", () => {
    expect(describeLockedSkillSource({ repo: "mattpocock/skills", path: "skills/grilling" })).toBe(
      "GitHub: mattpocock/skills",
    );
    expect(describeLockedSkillSource(null)).toBe("Uploaded");
  });
});

describe("buildSkillImportQuery", () => {
  it("sends a GitHub source the lock file gives, and replace only when asked", () => {
    const source = { repo: "mattpocock/skills", path: "skills/grilling" };
    expect(buildSkillImportQuery({ name: "grilling", source }, true)).toEqual({
      name: "grilling",
      replace: true,
      sourceRepo: "mattpocock/skills",
      sourcePath: "skills/grilling",
    });
    expect(buildSkillImportQuery({ name: "grilling", source: null }, false)).toEqual({
      name: "grilling",
    });
  });
});

describe("importSkillArchive", () => {
  /** Returns a client whose `skill.import` records its request and settles as `settle` does. */
  const fakeClient = (settle: () => Promise<unknown>) => {
    const requests: Array<unknown> = [];
    const client = {
      skill: {
        import: (request: unknown) => {
          requests.push(request);
          return settle();
        },
      },
    } as unknown as HerculeClient;
    return { client, requests };
  };
  const query: SkillImportInput = { name: "teach", replace: true };
  const archive = new Uint8Array([1, 2, 3]);

  /** Returns the outcome of an import the controller answers with `result`. */
  const importAnswered = (result: "created" | "revised" | "unchanged") =>
    importSkillArchive(
      fakeClient(() => Promise.resolve({ result, skill: SKILL })).client,
      query,
      archive,
    );

  /** Returns the outcome of an import whose request fails with `error`. */
  const importFailing = (error: Error) =>
    importSkillArchive(fakeClient(() => Promise.reject(error)).client, query, archive);

  it("sends the archive with the query and returns what became of the skill", async () => {
    const { client, requests } = fakeClient(() =>
      Promise.resolve({ result: "revised", skill: SKILL }),
    );

    expect(await importSkillArchive(client, query, archive)).toEqual({ kind: "imported" });
    expect(requests).toEqual([{ query, payload: archive }]);
  });

  it("counts a created or revised skill as imported, and tells an unchanged one apart", async () => {
    expect(await importAnswered("created")).toEqual({ kind: "imported" });
    expect(await importAnswered("revised")).toEqual({ kind: "imported" });
    expect(await importAnswered("unchanged")).toEqual({ kind: "unchanged" });
  });

  it("leaves a conflict for the user to confirm", async () => {
    expect(await importFailing(new ApiError("conflict", "`teach` differs"))).toEqual({
      kind: "conflict",
    });
  });

  it("joins the issues of a refused content rule", async () => {
    const refusal = new ApiError("validation", "the skill's content is not valid", {
      issues: [
        { path: [], message: "`teach` has no `SKILL.md` at its root." },
        { path: [], message: "`name` must be `teach`." },
      ],
    });
    expect(await importFailing(refusal)).toEqual({
      kind: "refused",
      reason: "`teach` has no `SKILL.md` at its root. `name` must be `teach`.",
    });
  });

  it("names the field of an issue that has a path", async () => {
    const refusal = new ApiError("validation", "the query is invalid", {
      issues: [{ path: ["sourceRepo"], message: "Expected a GitHub repository" }],
    });
    expect(await importFailing(refusal)).toEqual({
      kind: "refused",
      reason: "sourceRepo: Expected a GitHub repository",
    });
  });

  it("gives the message of any other refusal", async () => {
    expect(await importFailing(new ApiError("cap_exceeded", "the library is full"))).toEqual({
      kind: "refused",
      reason: "the library is full",
    });
    expect(await importFailing(new ApiError("validation", "no issues"))).toEqual({
      kind: "refused",
      reason: "no issues",
    });
  });

  it("rejects with an error about the connection or the credential, so the import stops", async () => {
    const unreachable = new ConnectionError("http://controller.test", undefined);
    const forbidden = new ApiError("forbidden", "you lack skill.write");
    await expect(importFailing(unreachable)).rejects.toBe(unreachable);
    await expect(importFailing(forbidden)).rejects.toBe(forbidden);
  });
});

describe("isSkillImportRefusal", () => {
  it("counts the controller refusing one skill, a conflict included", () => {
    expect(isSkillImportRefusal(new ApiError("validation", "not valid"))).toBe(true);
    expect(isSkillImportRefusal(new ApiError("conflict", "differs"))).toBe(true);
  });

  it("does not count an error about the credential or the connection", () => {
    expect(isSkillImportRefusal(new ApiError("forbidden", "no grant"))).toBe(false);
    expect(isSkillImportRefusal(new ApiError("unauthenticated", "signed out"))).toBe(false);
    expect(isSkillImportRefusal(new ConnectionError("http://controller.test", undefined))).toBe(
      false,
    );
    expect(isSkillImportRefusal(new Error("anything else"))).toBe(false);
  });
});

describe("countSkillImportOutcomes", () => {
  it("counts each kind, and a conflict nobody confirmed as skipped", () => {
    expect(
      countSkillImportOutcomes([
        { kind: "imported" },
        { kind: "imported" },
        { kind: "unchanged" },
        { kind: "refused", reason: "no" },
        { kind: "skipped" },
        { kind: "conflict" },
      ]),
    ).toEqual({ imported: 2, unchanged: 1, refused: 1, skipped: 2 });
  });
});

const revision = (hash: string, description: string): SkillRevision => ({
  revisionHash: hash,
  origin: "import",
  fileCount: 2,
  sizeBytes: 6656,
  description,
  createdAt: "2026-10-18T10:00:00Z",
  createdBy: "user",
  appliedAt: "2026-10-18T10:00:00Z",
  appliedBy: "user",
  includesThirdPartyContent: false,
});

describe("findCurrentSkillRevision", () => {
  it("finds the history entry of the current revision", () => {
    const detail: SkillDetail = {
      skill: SKILL,
      files: [],
      skillMd: "# Teach",
      history: [
        revision("a".repeat(64), "newer, not current"),
        revision("b".repeat(64), "current"),
      ],
      availableRevision: null,
      proposedRevisions: [],
    };
    expect(findCurrentSkillRevision(detail)?.description).toBe("current");
    expect(
      findCurrentSkillRevision({ ...detail, skill: { ...SKILL, currentRevisionHash: null } }),
    ).toBeUndefined();
  });
});

describe("findSkillMdSize", () => {
  it("returns the size of SKILL.md at the root, or 0 without one", () => {
    const files = [
      { path: "docs/SKILL.md", mode: "644", sizeBytes: 10 },
      { path: "SKILL.md", mode: "644", sizeBytes: 812 },
    ] as const;
    expect(findSkillMdSize(files)).toBe(812);
    expect(findSkillMdSize(files.slice(0, 1))).toBe(0);
  });
});

describe("isExecutableSkillFile", () => {
  it("checks for mode 755", () => {
    expect(isExecutableSkillFile({ path: "run.sh", mode: "755", sizeBytes: 1 })).toBe(true);
    expect(isExecutableSkillFile({ path: "SKILL.md", mode: "644", sizeBytes: 1 })).toBe(false);
  });
});
