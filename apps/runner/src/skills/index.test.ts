/**
 * Tests the runner's skill cache and the sessions' skills folders against a
 * stub controller.
 */
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { MAX_SKILL_BYTES, type SessionSkill } from "@hercule/protocol";
import { makeSkillStore } from "./index";
import {
  buildTestSkillRevision,
  nameTestSkill,
  startSkillController,
  type SkillControllerStub,
  type TestSkillRevision,
} from "./testing";

const CREDENTIAL = "runner-credential-for-a-test";
const SESSION_A = "0199e0e7-0000-7000-8000-0000000000a1";
const SESSION_B = "0199e0e7-0000-7000-8000-0000000000b2";

const IMPLEMENT = await buildTestSkillRevision({
  "SKILL.md": "# implement",
  "scripts/run.sh": "#!/bin/sh\necho run\n",
});
const REVIEW = await buildTestSkillRevision({ "SKILL.md": "# review" });

const stubs: Array<SkillControllerStub> = [];
const roots: Array<string> = [];

afterAll(() => {
  for (const stub of stubs.splice(0)) stub.stop();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Starts a stub controller that serves the given revisions, and 404 for any other. */
const serve = (...revisions: ReadonlyArray<TestSkillRevision>): SkillControllerStub => {
  const stub = startSkillController(
    Object.fromEntries(revisions.map((revision) => [revision.revisionHash, revision.archive])),
  );
  stubs.push(stub);
  return stub;
};

/** Creates a store over fresh folders that fetches from `stub`. */
const createStore = (stub: SkillControllerStub, deadline?: Duration.Duration) => {
  const root = mkdtempSync(join(tmpdir(), "hercule-skills-"));
  roots.push(root);
  const skillsDir = join(root, "skills");
  const sessionSkillsDir = join(root, "session-skills");
  const store = makeSkillStore({
    skillsDir,
    sessionSkillsDir,
    credential: CREDENTIAL,
    readControllerUrl: () => stub.url,
    ...(deadline === undefined ? {} : { deadline }),
  });
  return { store, skillsDir, sessionSkillsDir };
};

/** Returns the entries of a folder, sorted, or an empty list when it does not exist. */
const listFolder = (path: string): ReadonlyArray<string> =>
  existsSync(path) ? readdirSync(path).sort() : [];

/** Returns the permission bits of a file, in octal. */
const readMode = (path: string): string => (statSync(path).mode & 0o777).toString(8);

/** Prepares a start's skills and returns the error it failed with. Fails the test when it succeeds. */
const prepareFailing = async (
  store: ReturnType<typeof createStore>["store"],
  skills: ReadonlyArray<SessionSkill>,
): Promise<string> => {
  const hold = store.hold(skills);
  const exit = await Effect.runPromiseExit(hold.prepare(SESSION_A));
  await Effect.runPromise(hold.release);
  if (Exit.isSuccess(exit)) throw new Error("the start was expected to be refused");
  return Exit.isFailure(exit) && exit.cause.reasons[0]?._tag === "Fail"
    ? exit.cause.reasons[0].error
    : String(exit.cause);
};

/** Writes the checksum of the first header of an archive again, after a test changed the header. */
const fixHeaderChecksum = (bytes: Uint8Array): Uint8Array => {
  let sum = 0;
  for (let index = 0; index < 512; index++)
    sum += index >= 148 && index < 156 ? 0x20 : bytes[index]!;
  bytes.set(new TextEncoder().encode(`${sum.toString(8).padStart(6, "0")}\0 `), 148);
  return bytes;
};

/** Returns a copy of a revision's archive whose first entry has another typeflag. */
const retagFirstEntry = (revision: TestSkillRevision, typeflag: string): Uint8Array => {
  const bytes = Uint8Array.from(revision.archive);
  bytes[156] = typeflag.charCodeAt(0);
  return fixHeaderChecksum(bytes);
};

describe("a start's skills", () => {
  it("fetches a revision with the runner's credential and copies it into the session's plugin folder with its modes", async () => {
    const stub = serve(IMPLEMENT);
    const { store, skillsDir, sessionSkillsDir } = createStore(stub);

    const hold = store.hold([nameTestSkill("implement", IMPLEMENT)]);
    const folder = await Effect.runPromise(hold.prepare(SESSION_A));

    expect(folder).toBe(join(sessionSkillsDir, SESSION_A));
    expect(stub.requested).toEqual([IMPLEMENT.revisionHash]);
    expect(stub.authorizations).toEqual([`Bearer ${CREDENTIAL}`]);
    expect(
      JSON.parse(readFileSync(join(folder!, ".claude-plugin", "plugin.json"), "utf8")),
    ).toEqual({ name: "skills" });
    expect(readFileSync(join(folder!, "skills", "implement", "SKILL.md"), "utf8")).toBe(
      "# implement",
    );
    // The mode comes from the archive, in the cache and in the copy alike.
    expect(readMode(join(skillsDir, IMPLEMENT.revisionHash, "scripts", "run.sh"))).toBe("755");
    expect(readMode(join(folder!, "skills", "implement", "scripts", "run.sh"))).toBe("755");
    expect(readMode(join(folder!, "skills", "implement", "SKILL.md"))).toBe("644");
    expect(listFolder(skillsDir)).toEqual([IMPLEMENT.revisionHash]);
    await Effect.runPromise(hold.release);
  });

  it("makes no folder and fetches nothing for a start that names no skills", async () => {
    const stub = serve();
    const { store, sessionSkillsDir } = createStore(stub);

    const hold = store.hold([]);

    expect(await Effect.runPromise(hold.prepare(SESSION_A))).toBeUndefined();
    expect(stub.requested).toEqual([]);
    expect(listFolder(sessionSkillsDir)).toEqual([]);
  });

  it("takes a cached revision from the cache without asking the controller again", async () => {
    const stub = serve(IMPLEMENT);
    const { store } = createStore(stub);
    const first = store.hold([nameTestSkill("implement", IMPLEMENT)]);
    await Effect.runPromise(first.prepare(SESSION_A));

    const second = store.hold([nameTestSkill("implement", IMPLEMENT)]);
    const folder = await Effect.runPromise(second.prepare(SESSION_B));

    expect(stub.requested).toEqual([IMPLEMENT.revisionHash]);
    expect(listFolder(join(folder!, "skills"))).toEqual(["implement"]);
    await Effect.runPromise(Effect.andThen(first.release, second.release));
  });

  it("fetches a revision once for two starts that name it at the same time", async () => {
    const stub = serve(IMPLEMENT);
    const { store, sessionSkillsDir } = createStore(stub);
    let open = (): void => {};
    stub.hold = new Promise((resolve) => (open = resolve));
    const first = store.hold([nameTestSkill("implement", IMPLEMENT)]);
    const second = store.hold([nameTestSkill("implement", IMPLEMENT)]);

    const both = Effect.runPromise(
      Effect.all([first.prepare(SESSION_A), second.prepare(SESSION_B)], {
        concurrency: "unbounded",
      }),
    );
    await Effect.runPromise(
      Effect.gen(function* () {
        while (stub.requested.length === 0) yield* Effect.sleep(1);
      }),
    );
    open();
    await both;

    expect(stub.requested).toEqual([IMPLEMENT.revisionHash]);
    expect(listFolder(join(sessionSkillsDir, SESSION_A, "skills"))).toEqual(["implement"]);
    expect(listFolder(join(sessionSkillsDir, SESSION_B, "skills"))).toEqual(["implement"]);
    await Effect.runPromise(Effect.andThen(first.release, second.release));
  });

  it("gives each session the skills its own start named", async () => {
    const stub = serve(IMPLEMENT, REVIEW);
    const { store } = createStore(stub);
    const first = store.hold([nameTestSkill("implement", IMPLEMENT)]);
    const second = store.hold([
      nameTestSkill("implement", IMPLEMENT),
      nameTestSkill("review", REVIEW),
    ]);

    const folderA = await Effect.runPromise(first.prepare(SESSION_A));
    const folderB = await Effect.runPromise(second.prepare(SESSION_B));

    expect(listFolder(join(folderA!, "skills"))).toEqual(["implement"]);
    expect(listFolder(join(folderB!, "skills"))).toEqual(["implement", "review"]);
    await Effect.runPromise(Effect.andThen(first.release, second.release));
  });

  it("rebuilds the session's folder from scratch when the session starts again", async () => {
    const stub = serve(IMPLEMENT, REVIEW);
    const { store } = createStore(stub);
    const first = store.hold([nameTestSkill("implement", IMPLEMENT)]);
    await Effect.runPromise(first.prepare(SESSION_A));

    // A resume of the same session, with the library changed in between.
    const resumed = store.hold([nameTestSkill("review", REVIEW)]);
    const folder = await Effect.runPromise(resumed.prepare(SESSION_A));

    expect(listFolder(join(folder!, "skills"))).toEqual(["review"]);
    await Effect.runPromise(Effect.andThen(first.release, resumed.release));
  });
});

describe("releasing a start's skills", () => {
  it("removes the session's folder and every cached revision no other start holds", async () => {
    const stub = serve(IMPLEMENT, REVIEW);
    const { store, skillsDir, sessionSkillsDir } = createStore(stub);
    const first = store.hold([nameTestSkill("implement", IMPLEMENT)]);
    const second = store.hold([nameTestSkill("review", REVIEW)]);
    await Effect.runPromise(first.prepare(SESSION_A));
    await Effect.runPromise(second.prepare(SESSION_B));

    await Effect.runPromise(first.release);

    expect(listFolder(sessionSkillsDir)).toEqual([SESSION_B]);
    expect(listFolder(skillsDir)).toEqual([REVIEW.revisionHash]);

    await Effect.runPromise(second.release);

    expect(listFolder(sessionSkillsDir)).toEqual([]);
    expect(listFolder(skillsDir)).toEqual([]);
  });

  it("keeps a revision another start still holds, even one that has not been prepared yet", async () => {
    const stub = serve(IMPLEMENT);
    const { store, skillsDir } = createStore(stub);
    const first = store.hold([nameTestSkill("implement", IMPLEMENT)]);
    await Effect.runPromise(first.prepare(SESSION_A));
    const waiting = store.hold([nameTestSkill("implement", IMPLEMENT)]);

    await Effect.runPromise(first.release);

    expect(listFolder(skillsDir)).toEqual([IMPLEMENT.revisionHash]);
    await Effect.runPromise(waiting.prepare(SESSION_B));
    expect(stub.requested).toEqual([IMPLEMENT.revisionHash]);
    await Effect.runPromise(waiting.release);
  });

  it("leaves the folder a later start of the same session rebuilt", async () => {
    const stub = serve(IMPLEMENT, REVIEW);
    const { store, skillsDir, sessionSkillsDir } = createStore(stub);
    const earlier = store.hold([nameTestSkill("implement", IMPLEMENT)]);
    await Effect.runPromise(earlier.prepare(SESSION_A));
    // The session is started again while the teardown of its earlier run
    // has not released the earlier hold yet.
    const later = store.hold([nameTestSkill("review", REVIEW)]);
    await Effect.runPromise(later.prepare(SESSION_A));

    await Effect.runPromise(earlier.release);

    expect(listFolder(join(sessionSkillsDir, SESSION_A, "skills"))).toEqual(["review"]);
    expect(listFolder(skillsDir)).toEqual([REVIEW.revisionHash]);
    await Effect.runPromise(later.release);
    expect(listFolder(sessionSkillsDir)).toEqual([]);
  });

  it("does nothing the second time", async () => {
    const stub = serve(IMPLEMENT);
    const { store, skillsDir } = createStore(stub);
    const first = store.hold([nameTestSkill("implement", IMPLEMENT)]);
    await Effect.runPromise(first.prepare(SESSION_A));
    await Effect.runPromise(first.release);
    const second = store.hold([nameTestSkill("implement", IMPLEMENT)]);
    await Effect.runPromise(second.prepare(SESSION_B));

    await Effect.runPromise(first.release);

    // A second release of the first hold would have dropped the count of the
    // second start's revision to zero and removed it.
    expect(listFolder(skillsDir)).toEqual([IMPLEMENT.revisionHash]);
    await Effect.runPromise(second.release);
  });
});

describe("a revision the runner refuses", () => {
  const shortHash = (revision: TestSkillRevision): string => revision.revisionHash.slice(0, 8);

  /** Checks that a refused start left nothing behind: no cached revision, no temp folder, no session folder. */
  const expectNothingLeft = (folders: { skillsDir: string; sessionSkillsDir: string }): void => {
    expect(listFolder(folders.skillsDir)).toEqual([]);
    expect(listFolder(folders.sessionSkillsDir)).toEqual([]);
  };

  it("refuses files that do not match the revision's hash", async () => {
    // The stub serves the review skill's files under the implement skill's hash.
    const stub = startSkillController({ [IMPLEMENT.revisionHash]: REVIEW.archive });
    stubs.push(stub);
    const folders = createStore(stub);

    const message = await prepareFailing(folders.store, [nameTestSkill("implement", IMPLEMENT)]);

    expect(message).toBe(
      `Could not load skill \`implement\` (revision ${shortHash(IMPLEMENT)}...) from the controller: the files the controller sent do not match the revision's hash. The Thread did not start.`,
    );
    expectNothingLeft(folders);
  });

  it("refuses a path that breaks the path rules", async () => {
    const bad = await buildTestSkillRevision({ "SKILL.md": "# bad", "../escape.md": "out" });
    const stub = serve(bad);
    const folders = createStore(stub);

    const message = await prepareFailing(folders.store, [nameTestSkill("bad", bad)]);

    expect(message).toMatch(
      new RegExp(
        `^Could not load skill \`bad\` \\(revision ${shortHash(bad)}\\.\\.\\.\\) from the controller: .*\\.\\.\\/escape\\.md.* The Thread did not start\\.$`,
      ),
    );
    expectNothingLeft(folders);
  });

  it("refuses an archive entry that is not a regular file", async () => {
    const stub = startSkillController({
      [IMPLEMENT.revisionHash]: retagFirstEntry(IMPLEMENT, "2"),
    });
    stubs.push(stub);
    const folders = createStore(stub);

    const message = await prepareFailing(folders.store, [nameTestSkill("implement", IMPLEMENT)]);

    expect(message).toContain("is a symbolic link, and a skill holds only regular files.");
    expectNothingLeft(folders);
  });

  it("refuses a file whose mode is neither 644 nor 755", async () => {
    const bytes = Uint8Array.from(IMPLEMENT.archive);
    // The mode field of the first header, then its checksum, fixed so the archive still reads.
    bytes.set(new TextEncoder().encode("0000600\0"), 100);
    const stub = startSkillController({ [IMPLEMENT.revisionHash]: fixHeaderChecksum(bytes) });
    stubs.push(stub);
    const folders = createStore(stub);

    const message = await prepareFailing(folders.store, [nameTestSkill("implement", IMPLEMENT)]);

    expect(message).toContain("has mode 600, and a skill's files have mode 644 or 755.");
    expectNothingLeft(folders);
  });

  it("gives up on an archive larger than the limit", async () => {
    const stub = startSkillController({
      // Streamed with no length announced, so the runner has to count.
      [IMPLEMENT.revisionHash]: () =>
        new Response(
          new ReadableStream({
            pull: (controller) => controller.enqueue(new Uint8Array(1024 * 1024)),
          }),
        ),
    });
    stubs.push(stub);
    const folders = createStore(stub);

    const message = await prepareFailing(folders.store, [nameTestSkill("implement", IMPLEMENT)]);

    expect(message).toContain(
      `the skill's archive is larger than ${String(MAX_SKILL_BYTES / 1024 / 1024)} MiB.`,
    );
    expectNothingLeft(folders);
  });

  it("refuses a revision the controller does not serve, with the controller's message", async () => {
    const stub = serve();
    const folders = createStore(stub);

    const message = await prepareFailing(folders.store, [nameTestSkill("implement", IMPLEMENT)]);

    expect(message).toBe(
      `Could not load skill \`implement\` (revision ${shortHash(IMPLEMENT)}...) from the controller: No applied Skill Revision has this hash. The Thread did not start.`,
    );
    expectNothingLeft(folders);
  });

  it("refuses a start whose skills are not ready at the deadline, naming the skill", async () => {
    const stub = serve(IMPLEMENT);
    stub.hold = new Promise(() => {});
    const folders = createStore(stub, Duration.millis(100));

    const message = await prepareFailing(folders.store, [nameTestSkill("implement", IMPLEMENT)]);

    expect(message).toBe(
      `Could not load skill \`implement\` (revision ${shortHash(IMPLEMENT)}...) from the controller: it was not ready within 0.1 seconds. The Thread did not start.`,
    );
    expectNothingLeft(folders);
  });
});
