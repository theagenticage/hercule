import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Duration, Effect, Layer } from "effect";
import { TestClock } from "effect/testing";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import {
  BUILT_IN_SKILL_NAME,
  MAX_SKILLS,
  ONLY_THE_USER_IMPORTS_SKILLS,
  type Grant,
} from "@hercule/contract";
import { buildSkillArchive, computeSkillRevisionHash, type SkillFile } from "@hercule/protocol";
import { CurrentActor, type Actor } from "../actor";
import { buildHomePaths, HerculeHome } from "../config";
import { TestDatabase } from "../db/testing";
import { AuditLogLayer } from "../events";
import { readEventsOfKind } from "../events/testing";
import { buildSkillArchivePath, buildSkillsFolder } from "./files";
import { SkillService, SkillServiceLayer } from "./service";

type Deps = SkillService | SqlClient.SqlClient | HerculeHome;

const USER: Actor = {
  _tag: "user",
  userId: "0199f0b7-0000-7000-8000-000000000000",
  credential: { kind: "login", id: "0199f0b7-0001-7000-8000-000000000000", tokenHash: "x" },
};

const SKILL_GRANTS: ReadonlyArray<Grant> = ["skill.read", "skill.write", "skill.apply"];

/** A session that holds every skill grant, so only the rule for sessions can refuse it. */
const SESSION: Actor = {
  _tag: "session",
  sessionId: "0199f0b7-0000-7000-8000-00000000005e",
  profileId: "0199f0b7-0000-7000-8000-0000000000f0",
  grants: SKILL_GRANTS,
  profileGrants: SKILL_GRANTS,
  assistantId: null,
  agentId: null,
};

const AT = "2026-10-18T00:00:00.000Z";
const GITHUB_HASH = "c".repeat(64);
const GITHUB_SOURCE = { sourceRepo: "acme/skills", sourcePath: "skills/teach" } as const;

let homes: Array<string> = [];

afterEach(() => {
  for (const home of homes) rmSync(home, { recursive: true, force: true });
  homes = [];
});

/** Builds the service over a `:memory:` database and a fresh Data Root. */
const buildStack = () => {
  const home = mkdtempSync(join(tmpdir(), "hercule-skill-service-"));
  homes.push(home);
  return SkillServiceLayer.pipe(
    Layer.provideMerge(AuditLogLayer),
    Layer.provideMerge(TestDatabase),
    Layer.provideMerge(Layer.succeed(HerculeHome, buildHomePaths(home, join(home, "data")))),
  );
};

const runAs = <A, E>(actor: Actor, effect: Effect.Effect<A, E, Deps>) =>
  Effect.runPromise(
    Effect.provideService(effect, CurrentActor, actor).pipe(
      Effect.provide(buildStack()),
      Effect.provide(TestClock.layer()),
    ),
  );

const run = <A, E>(effect: Effect.Effect<A, E, Deps>) => runAs(USER, effect);

/** Runs a call that is expected to fail, as the user, and returns its error. */
const runError = <A, E>(effect: Effect.Effect<A, E, Deps>) => run(Effect.flip(effect));

/** Returns the code, message and details of an API error, the parts the caller reads. */
const readApiError = (error: unknown) =>
  (
    error as {
      readonly error: {
        readonly code: string;
        readonly message: string;
        readonly details?: unknown;
      };
    }
  ).error;

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);

/** Returns a valid skill's files: a `SKILL.md` with `body`, and any `extra` files. */
const buildFiles = (
  name: string,
  body = "Body\n",
  extra: ReadonlyArray<SkillFile> = [],
): ReadonlyArray<SkillFile> => [
  {
    path: "SKILL.md",
    mode: "644",
    content: encode(`---\nname: ${name}\ndescription: Teaches.\n---\n${body}`),
  },
  ...extra,
];

/** Imports `files` as the skill `name`, with any other query fields. */
const importSkill = (
  name: string,
  files: ReadonlyArray<SkillFile>,
  query: Partial<{
    replace: boolean;
    sourceRepo: string;
    sourcePath: string;
    sourceBranch: string;
  }> = {},
) =>
  Effect.gen(function* () {
    const service = yield* SkillService;
    const archive = yield* buildSkillArchive(files);
    return yield* service.import({ name, ...query }, archive);
  });

/** Returns the path of the archive file of the revision with this hash. */
const readArchivePath = (hash: string) =>
  Effect.map(HerculeHome, ({ dataDir }) => buildSkillArchivePath(dataDir, hash));

/** Inserts a Skill row with no current revision, as a Skill that exists only as a proposal. */
const insertSkillWithoutCurrent = (name: string) =>
  Effect.flatMap(SqlClient.SqlClient, (sql) =>
    Effect.asVoid(sql`
      INSERT INTO skills (id, name, source, created_at, created_by, updated_at, updated_by)
      VALUES (randomblob(16), ${name}, '{"kind":"upload"}', ${AT}, 'user', ${AT}, 'user')`),
  );

/**
 * Gives the Skill `name` what an update check of its GitHub source leaves: a
 * `github` revision that was never applied, named as available, with its
 * archive file, and the check's time and error.
 */
const insertAvailableGithubRevision = (name: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO skill_revisions
        (skill_id, hash, origin, file_count, size_bytes, description, created_at, created_by)
      SELECT id, ${GITHUB_HASH}, 'github', 1, 10, 'Teaches.', ${AT}, 'user'
      FROM skills WHERE name = ${name}`;
    yield* sql`
      UPDATE skills SET available_revision_hash = ${GITHUB_HASH}, last_checked_at = ${AT},
                        check_error = 'rate limited'
      WHERE name = ${name}`;
    mkdirSync(buildSkillsFolder((yield* HerculeHome).dataDir), { recursive: true });
    writeFileSync(yield* readArchivePath(GITHUB_HASH), "");
  });

const countRevisions = Effect.flatMap(SqlClient.SqlClient, (sql) =>
  Effect.map(
    sql<{ readonly count: number }>`SELECT count(*) AS count FROM skill_revisions`,
    (rows) => rows[0]?.count ?? 0,
  ),
);

describe("skill.import", () => {
  it("creates a Skill whose current revision is the imported content, and audits it", async () => {
    const { result, skill, archiveExists, entries } = await run(
      Effect.gen(function* () {
        const imported = yield* importSkill("teach", buildFiles("teach"));
        const hash = imported.skill.currentRevisionHash ?? "";
        return {
          ...imported,
          archiveExists: existsSync(yield* readArchivePath(hash)),
          entries: yield* readEventsOfKind("skill.imported"),
        };
      }),
    );
    expect(result).toBe("created");
    expect(skill).toMatchObject({
      name: "teach",
      source: { kind: "upload" },
      currentApprovalEffects: { allowedTools: null, hooks: null },
      currentFileCount: 1,
      availableRevisionHash: null,
      proposedCount: 0,
      createdBy: "user",
    });
    expect(skill.currentRevisionHash).toMatch(/^[0-9a-f]{64}$/);
    expect(archiveExists).toBe(true);
    expect(entries.map((entry) => entry.payload)).toEqual([
      {
        name: "teach",
        result: "created",
        revisionHash: skill.currentRevisionHash,
        previousRevisionHash: null,
        source: { kind: "upload" },
        previousSource: null,
      },
    ]);
  });

  it("answers unchanged for the current content and the same source, and writes nothing", async () => {
    const outcome = await run(
      Effect.gen(function* () {
        const first = yield* importSkill("teach", buildFiles("teach"));
        yield* TestClock.adjust(Duration.minutes(1));
        const second = yield* importSkill("teach", buildFiles("teach"));
        return { first, second, entries: yield* readEventsOfKind("skill.imported") };
      }),
    );
    expect(outcome.second.result).toBe("unchanged");
    expect(outcome.second.skill).toEqual(outcome.first.skill);
    expect(outcome.entries).toHaveLength(1);
  });

  it("refuses other content without replace, naming both hashes", async () => {
    const { error, refusedArchiveExists, created, imported } = await run(
      Effect.gen(function* () {
        const created = yield* importSkill("teach", buildFiles("teach"));
        const other = buildFiles("teach", "Other\n");
        const archive = yield* buildSkillArchive(other);
        const service = yield* SkillService;
        const error = yield* Effect.flip(service.import({ name: "teach" }, archive));
        // The archive was published before the transaction refused the import.
        const refusedArchiveExists = existsSync(
          yield* readArchivePath(yield* computeSkillRevisionHash(other)),
        );
        const imported = yield* importSkill("teach", other, { replace: true });
        return { error, refusedArchiveExists, created, imported };
      }),
    );
    expect(refusedArchiveExists).toBe(false);
    const before = created.skill.currentRevisionHash ?? "";
    const after = imported.skill.currentRevisionHash ?? "";
    expect(readApiError(error)).toEqual({
      code: "conflict",
      message: `\`teach\` exists with different content (current revision \`${before}\`, imported content \`${after}\`). Import with --replace true to make the imported content current.`,
    });
    expect(imported.result).toBe("revised");
    expect(after).not.toBe(before);
  });

  it("revises a Skill with no current revision without replace", async () => {
    const imported = await run(
      Effect.andThen(insertSkillWithoutCurrent("teach"), importSkill("teach", buildFiles("teach"))),
    );
    expect(imported.result).toBe("revised");
    expect(imported.skill.currentRevisionHash).not.toBeNull();
  });

  it("reuses the revision with the same hash when earlier content is imported again", async () => {
    const { first, back, detail, revisions } = await run(
      Effect.gen(function* () {
        const first = yield* importSkill("teach", buildFiles("teach"));
        yield* TestClock.adjust(Duration.minutes(1));
        yield* importSkill("teach", buildFiles("teach", "Other\n"), { replace: true });
        yield* TestClock.adjust(Duration.minutes(1));
        const back = yield* importSkill("teach", buildFiles("teach"), { replace: true });
        const service = yield* SkillService;
        return {
          first,
          back,
          detail: yield* service.read("teach"),
          revisions: yield* countRevisions,
        };
      }),
    );
    expect(back.result).toBe("revised");
    expect(back.skill.currentRevisionHash).toBe(first.skill.currentRevisionHash);
    expect(revisions).toBe(2);
    // The reused revision keeps only its last apply, so it is first in the history.
    expect(detail.history).toHaveLength(2);
    expect(detail.history[0]?.revisionHash).toBe(first.skill.currentRevisionHash);
    expect(detail.history[0]?.appliedAt).toBe("1970-01-01T00:02:00.000Z");
    expect(detail.history[0]?.createdAt).toBe("1970-01-01T00:00:00.000Z");
  });

  it("sets a changed source with unchanged content, clearing the last check and its unapplied github revisions", async () => {
    const outcome = await run(
      Effect.gen(function* () {
        yield* importSkill("teach", buildFiles("teach"), GITHUB_SOURCE);
        yield* insertAvailableGithubRevision("teach");
        const imported = yield* importSkill("teach", buildFiles("teach"));
        return {
          imported,
          revisions: yield* countRevisions,
          archiveExists: existsSync(yield* readArchivePath(GITHUB_HASH)),
          entries: yield* readEventsOfKind("skill.imported"),
        };
      }),
    );
    expect(outcome.imported.result).toBe("unchanged");
    expect(outcome.imported.skill).toMatchObject({
      source: { kind: "upload" },
      availableRevisionHash: null,
      lastCheckedAt: null,
      checkError: null,
    });
    expect(outcome.revisions).toBe(1);
    expect(outcome.archiveExists).toBe(false);
    expect(outcome.entries.map((entry) => entry.payload)).toEqual([
      expect.objectContaining({ result: "created" }),
      expect.objectContaining({
        result: "unchanged",
        source: { kind: "upload" },
        previousSource: { kind: "github", repo: "acme/skills", path: "skills/teach", branch: null },
      }),
    ]);
  });

  it("sets a changed source with revised content, and keeps the github revision a source change leaves alone", async () => {
    const outcome = await run(
      Effect.gen(function* () {
        yield* importSkill("teach", buildFiles("teach"), GITHUB_SOURCE);
        yield* insertAvailableGithubRevision("teach");
        const sameSource = yield* importSkill("teach", buildFiles("teach", "Other\n"), {
          ...GITHUB_SOURCE,
          replace: true,
        });
        const sameSourceRevisions = yield* countRevisions;
        const moved = yield* importSkill("teach", buildFiles("teach", "Third\n"), {
          sourceRepo: "acme/other",
          sourcePath: "teach",
          sourceBranch: "main",
          replace: true,
        });
        return {
          sameSource,
          sameSourceRevisions,
          moved,
          revisions: yield* countRevisions,
          archiveExists: existsSync(yield* readArchivePath(GITHUB_HASH)),
        };
      }),
    );
    expect(outcome.sameSource.skill).toMatchObject({
      availableRevisionHash: GITHUB_HASH,
      checkError: "rate limited",
    });
    expect(outcome.sameSourceRevisions).toBe(3);
    expect(outcome.moved.result).toBe("revised");
    expect(outcome.moved.skill).toMatchObject({
      source: { kind: "github", repo: "acme/other", path: "teach", branch: "main" },
      availableRevisionHash: null,
      lastCheckedAt: null,
      checkError: null,
    });
    expect(outcome.revisions).toBe(3);
    expect(outcome.archiveExists).toBe(false);
  });

  it("refuses a new name once the library holds MAX_SKILLS skills, and still revises an existing one", async () => {
    const { error, refusedArchiveExists, revised } = await run(
      Effect.gen(function* () {
        yield* Effect.forEach(
          Array.from({ length: MAX_SKILLS }, (_, index) => `skill-${String(index)}`),
          insertSkillWithoutCurrent,
          { discard: true },
        );
        const error = yield* Effect.flip(importSkill("teach", buildFiles("teach")));
        const refusedArchiveExists = existsSync(
          yield* readArchivePath(yield* computeSkillRevisionHash(buildFiles("teach"))),
        );
        const revised = yield* importSkill("skill-0", buildFiles("skill-0"));
        return { error, refusedArchiveExists, revised };
      }),
    );
    expect(refusedArchiveExists).toBe(false);
    expect(readApiError(error)).toEqual({
      code: "cap_exceeded",
      message: `The Skill Library holds ${String(MAX_SKILLS)} skills, the most it can hold. Delete a skill you no longer use, then try again.`,
      details: { count: MAX_SKILLS + 1, cap: MAX_SKILLS },
    });
    expect(revised.result).toBe("revised");
  });

  it("refuses a session whatever grants it holds, naming skill.apply", async () => {
    const error = await runAs(SESSION, Effect.flip(importSkill("teach", buildFiles("teach"))));
    expect(readApiError(error)).toEqual({
      code: "forbidden",
      message: ONLY_THE_USER_IMPORTS_SKILLS,
      details: { grant: "skill.apply" },
    });
  });

  it("refuses content that breaks content rules, listing every broken rule, and writes nothing", async () => {
    const { error, revisions, skillsFolder } = await run(
      Effect.gen(function* () {
        const files: ReadonlyArray<SkillFile> = [
          { path: "SKILL.md", mode: "644", content: encode("---\nname: other\n---\nBody\n") },
        ];
        const error = yield* Effect.flip(importSkill("teach", files));
        const { dataDir } = yield* HerculeHome;
        return {
          error,
          revisions: yield* countRevisions,
          skillsFolder: existsSync(join(dataDir, "skills")),
        };
      }),
    );
    const apiError = readApiError(error);
    expect(apiError.code).toBe("validation");
    expect(apiError.details).toEqual({
      issues: [
        {
          path: [],
          message:
            "`teach/SKILL.md` has `name: other`. A skill's name must match its folder name; rename the folder or the name.",
        },
        {
          path: [],
          message:
            "`teach/SKILL.md` has no `description`. Add one to its frontmatter: the agent reads it to decide when to use the skill.",
        },
      ],
    });
    expect(revisions).toBe(0);
    expect(skillsFolder).toBe(false);
  });

  it("refuses an archive that cannot be read as validation", async () => {
    const error = await runError(
      Effect.flatMap(SkillService, (service) =>
        service.import({ name: "teach" }, encode("not a tar archive")),
      ),
    );
    expect(readApiError(error).code).toBe("validation");
  });
});

describe("skill.read", () => {
  it("returns the current revision's files sorted by path, its SKILL.md and its history", async () => {
    const files = buildFiles("teach", "Body\n", [
      { path: "scripts/run.sh", mode: "755", content: encode("#!/bin/sh\n") },
      { path: "README.md", mode: "644", content: encode("Read me.\n") },
    ]);
    const detail = await run(
      Effect.gen(function* () {
        yield* importSkill("teach", buildFiles("teach", "First\n"));
        yield* TestClock.adjust(Duration.minutes(1));
        yield* importSkill("teach", files, { replace: true });
        return yield* Effect.flatMap(SkillService, (service) => service.read("teach"));
      }),
    );
    expect(detail.files).toEqual([
      { path: "README.md", mode: "644", sizeBytes: 9 },
      { path: "SKILL.md", mode: "644", sizeBytes: 47 },
      { path: "scripts/run.sh", mode: "755", sizeBytes: 10 },
    ]);
    expect(detail.skillMd).toBe("---\nname: teach\ndescription: Teaches.\n---\nBody\n");
    expect(detail.history.map((revision) => revision.appliedAt)).toEqual([
      "1970-01-01T00:01:00.000Z",
      "1970-01-01T00:00:00.000Z",
    ]);
    expect(detail.history[0]?.revisionHash).toBe(detail.skill.currentRevisionHash);
    expect(detail.availableRevision).toBeNull();
    expect(detail.proposedRevisions).toEqual([]);
  });

  it("is internal when the current revision's archive is missing, and says to import the skill again", async () => {
    const { error, dataDir } = await run(
      Effect.gen(function* () {
        const imported = yield* importSkill("teach", buildFiles("teach"));
        rmSync(yield* readArchivePath(imported.skill.currentRevisionHash ?? ""));
        const error = yield* Effect.flip(
          Effect.flatMap(SkillService, (service) => service.read("teach")),
        );
        return { error, dataDir: (yield* HerculeHome).dataDir };
      }),
    );
    expect(readApiError(error)).toEqual({
      code: "internal",
      message:
        "The files of the skill `teach` are missing from the controller's Data Root, as after a backup restored without its `skills/` folder. Import the skill again to restore its files.",
    });
    expect(readApiError(error).message).not.toContain(dataDir);
  });

  it.skipIf(process.getuid?.() === 0)(
    "is internal, naming the action and the skill, when the current revision's archive cannot be read",
    async () => {
      const error = await run(
        Effect.gen(function* () {
          const imported = yield* importSkill("teach", buildFiles("teach"));
          const archive = yield* readArchivePath(imported.skill.currentRevisionHash ?? "");
          chmodSync(archive, 0o000);
          try {
            return yield* Effect.flip(
              Effect.flatMap(SkillService, (service) => service.read("teach")),
            );
          } finally {
            chmodSync(archive, 0o600);
          }
        }),
      );
      expect(readApiError(error)).toEqual({
        code: "internal",
        message:
          "Could not read the files of the skill `teach` on the controller's disk. The controller's log has the details.",
      });
    },
  );

  it("returns the available revision of a Skill an update check found", async () => {
    const detail = await run(
      Effect.gen(function* () {
        yield* importSkill("teach", buildFiles("teach"), GITHUB_SOURCE);
        yield* insertAvailableGithubRevision("teach");
        return yield* Effect.flatMap(SkillService, (service) => service.read("teach"));
      }),
    );
    expect(detail.availableRevision).toMatchObject({ revisionHash: GITHUB_HASH, origin: "github" });
    expect(detail.history).toHaveLength(1);
  });

  it("is not_found for an unknown name and for the built-in skill", async () => {
    const errors = await run(
      Effect.flatMap(SkillService, (service) =>
        Effect.all([
          Effect.flip(service.read("missing")),
          Effect.flip(service.read(BUILT_IN_SKILL_NAME)),
        ]),
      ),
    );
    expect(errors.map((error) => readApiError(error))).toEqual([
      {
        code: "not_found",
        message: "no skill named `missing`; `hercule skill list` shows the skills there are",
      },
      {
        code: "not_found",
        message: `no skill named \`${BUILT_IN_SKILL_NAME}\`; \`hercule skill list\` shows the skills there are`,
      },
    ]);
  });
});

describe("skill.query", () => {
  it("returns every Skill sorted by name", async () => {
    const { items } = await run(
      Effect.gen(function* () {
        yield* importSkill("write", buildFiles("write"));
        yield* importSkill("teach", buildFiles("teach"));
        return yield* Effect.flatMap(SkillService, (service) => service.query());
      }),
    );
    expect(items.map((skill) => skill.name)).toEqual(["teach", "write"]);
  });
});

describe("skill.delete", () => {
  it("deletes the Skill, its revisions and their archives, and keeps an archive another Skill names", async () => {
    const outcome = await run(
      Effect.gen(function* () {
        const service = yield* SkillService;
        const teach = yield* importSkill("teach", buildFiles("teach"));
        yield* importSkill("teach", buildFiles("teach", "Other\n"), { replace: true });
        const firstHash = teach.skill.currentRevisionHash ?? "";
        // A second Skill with the same SKILL.md name cannot exist, so the
        // shared archive is made by a row of another Skill naming the hash.
        yield* insertSkillWithoutCurrent("grill");
        const sql = yield* SqlClient.SqlClient;
        yield* sql`
          INSERT INTO skill_revisions
            (skill_id, hash, origin, file_count, size_bytes, description, created_at, created_by)
          SELECT id, ${firstHash}, 'session', 1, 10, 'Teaches.', ${AT}, 'user'
          FROM skills WHERE name = 'grill'`;
        const detail = yield* service.read("teach");
        const secondHash = detail.skill.currentRevisionHash ?? "";
        const answer = yield* service.delete("teach");
        return {
          answer,
          firstHash,
          secondHash,
          names: (yield* service.query()).items.map((skill) => skill.name),
          revisions: yield* countRevisions,
          firstArchive: existsSync(yield* readArchivePath(firstHash)),
          secondArchive: existsSync(yield* readArchivePath(secondHash)),
          entries: yield* readEventsOfKind("skill.deleted"),
          missing: yield* Effect.flip(service.delete("teach")),
        };
      }),
    );
    expect(outcome.answer).toEqual({});
    expect(outcome.names).toEqual(["grill"]);
    expect(outcome.revisions).toBe(1);
    expect(outcome.firstArchive).toBe(true);
    expect(outcome.secondArchive).toBe(false);
    // The revisions are deleted in no set order, so the hashes are compared sorted.
    expect(outcome.entries).toHaveLength(1);
    const { name, revisionHashes } = outcome.entries[0]!.payload as {
      readonly name: string;
      readonly revisionHashes: ReadonlyArray<string>;
    };
    expect(name).toBe("teach");
    expect(revisionHashes.toSorted()).toEqual([outcome.firstHash, outcome.secondHash].toSorted());
    expect(readApiError(outcome.missing).code).toBe("not_found");
  });
});
