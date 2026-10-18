/**
 * Tests the runner's skills folders against a stub controller.
 */
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { MAX_SKILL_BYTES, type SessionSkill } from "@hercule/protocol";
import { makeSkillFolders } from "./index";
import {
  buildTestSkillRevision,
  buildTestSessionSkill,
  startSkillController,
  type SkillControllerStub,
  type TestSkillRevision,
} from "./testing";

const CREDENTIAL = "runner-credential-for-a-test";
const SESSION = "0199e0e7-0000-7000-8000-0000000000a1";

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

/** Creates the skills folders of a runner in a fresh folder, fetching from `stub`. */
const createFolders = (stub: SkillControllerStub, deadline?: Duration.Duration) => {
  const root = mkdtempSync(join(tmpdir(), "hercule-skills-"));
  roots.push(root);
  const sessionSkillsDir = join(root, "session-skills");
  const folders = makeSkillFolders({
    sessionSkillsDir,
    credential: CREDENTIAL,
    readControllerUrl: () => stub.url,
    ...(deadline === undefined ? {} : { deadline }),
  });
  return { folders, sessionSkillsDir };
};

/** Returns the permission bits of a file, in octal. */
const readMode = (path: string): string => (statSync(path).mode & 0o777).toString(8);

/** Fills a new folder with the skills and returns the error it failed with. Fails the test when it succeeds. */
const fillFailing = async (
  folders: ReturnType<typeof createFolders>["folders"],
  skills: ReadonlyArray<SessionSkill>,
): Promise<string> => {
  const exit = await Effect.runPromiseExit(
    folders.fillFolder(folders.buildFolderPath(SESSION), skills),
  );
  if (Exit.isSuccess(exit)) throw new Error("the start was expected to be refused");
  return exit.cause.reasons[0]?._tag === "Fail" ? exit.cause.reasons[0].error : String(exit.cause);
};

describe("a start's skills folder", () => {
  it("fetches each skill with the runner's credential and writes it into a Claude plugin with its modes", async () => {
    const stub = serve(IMPLEMENT, REVIEW);
    const { folders } = createFolders(stub);
    const folder = folders.buildFolderPath(SESSION);

    await Effect.runPromise(
      folders.fillFolder(folder, [
        buildTestSessionSkill("implement", IMPLEMENT),
        buildTestSessionSkill("review", REVIEW),
      ]),
    );

    expect([...stub.requested].sort()).toEqual(
      [IMPLEMENT.revisionHash, REVIEW.revisionHash].sort(),
    );
    expect(stub.authorizations).toEqual([`Bearer ${CREDENTIAL}`, `Bearer ${CREDENTIAL}`]);
    expect(JSON.parse(readFileSync(join(folder, ".claude-plugin", "plugin.json"), "utf8"))).toEqual(
      { name: "skills" },
    );
    expect(readdirSync(join(folder, "skills")).sort()).toEqual(["implement", "review"]);
    expect(readFileSync(join(folder, "skills", "implement", "SKILL.md"), "utf8")).toBe(
      "# implement",
    );
    expect(readMode(join(folder, "skills", "implement", "scripts", "run.sh"))).toBe("755");
    expect(readMode(join(folder, "skills", "implement", "SKILL.md"))).toBe("644");
  });

  it("gives every start of a session a path of its own, and creates nothing", () => {
    const { folders, sessionSkillsDir } = createFolders(serve());

    const first = folders.buildFolderPath(SESSION);
    const second = folders.buildFolderPath(SESSION);

    expect(first).not.toBe(second);
    for (const path of [first, second]) {
      expect(dirname(path)).toBe(sessionSkillsDir);
      expect(basename(path).startsWith(`${SESSION}-`)).toBe(true);
    }
    expect(existsSync(sessionSkillsDir)).toBe(false);
  });
});

describe("a revision the runner refuses", () => {
  const shortHash = (revision: TestSkillRevision): string => revision.revisionHash.slice(0, 8);

  it("refuses files that do not match the revision's hash", async () => {
    // The stub serves the review skill's files under the implement skill's hash.
    const stub = startSkillController({ [IMPLEMENT.revisionHash]: REVIEW.archive });
    stubs.push(stub);
    const { folders } = createFolders(stub);

    const message = await fillFailing(folders, [buildTestSessionSkill("implement", IMPLEMENT)]);

    expect(message).toBe(
      `Could not load skill \`implement\` (revision ${shortHash(IMPLEMENT)}...) from the controller: the archive's files do not match the revision's hash. The Thread did not start.`,
    );
  });

  it("refuses a path that breaks the path rules", async () => {
    const bad = await buildTestSkillRevision({ "SKILL.md": "# bad", "../escape.md": "out" });
    const stub = serve(bad);
    const { folders } = createFolders(stub);

    const message = await fillFailing(folders, [buildTestSessionSkill("bad", bad)]);

    expect(message).toMatch(
      new RegExp(
        `^Could not load skill \`bad\` \\(revision ${shortHash(bad)}\\.\\.\\.\\) from the controller: .*\\.\\.\\/escape\\.md.* The Thread did not start\\.$`,
      ),
    );
  });

  it("refuses a start whose folder the runner cannot make, naming no skill", async () => {
    const stub = serve(IMPLEMENT);
    const { folders, sessionSkillsDir } = createFolders(stub);
    // A file where the folder of the starts' folders belongs, so no folder can be made.
    writeFileSync(sessionSkillsDir, "");

    const message = await fillFailing(folders, [buildTestSessionSkill("implement", IMPLEMENT)]);

    expect(message).toMatch(
      /^The runner could not prepare the session's skills folder: .+\. The Thread did not start\.$/,
    );
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
    const { folders } = createFolders(stub);

    const message = await fillFailing(folders, [buildTestSessionSkill("implement", IMPLEMENT)]);

    expect(message).toContain(
      `the skill's archive is larger than ${String(MAX_SKILL_BYTES / 1024 / 1024)} MiB.`,
    );
  });

  it("refuses a revision the controller does not serve, with the controller's message", async () => {
    const stub = serve();
    const { folders } = createFolders(stub);

    const message = await fillFailing(folders, [buildTestSessionSkill("implement", IMPLEMENT)]);

    expect(message).toBe(
      `Could not load skill \`implement\` (revision ${shortHash(IMPLEMENT)}...) from the controller: No applied Skill Revision has this hash. The Thread did not start.`,
    );
  });

  it("refuses a start whose skills are not ready at the deadline, naming the skill", async () => {
    const stub = serve(IMPLEMENT);
    stub.delayResponsesUntil = new Promise(() => {});
    const { folders } = createFolders(stub, Duration.millis(100));

    const message = await fillFailing(folders, [buildTestSessionSkill("implement", IMPLEMENT)]);

    expect(message).toBe(
      `Could not load skill \`implement\` (revision ${shortHash(IMPLEMENT)}...) from the controller: it was not ready within 0.1 seconds. The Thread did not start.`,
    );
  });
});
