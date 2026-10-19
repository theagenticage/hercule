/**
 * Integration tests for `session.querySkills` and `session.previewSkills`, driven over HTTP against a
 * controller with a fake runner on the real runner socket. The fake runner
 * answers `repositorySkillsInspect` the way a real runner would: with the
 * skills it found in the workspace it was asked about.
 *
 * What the tests check:
 *
 * - A session lists the library skills it got at its last start, then the
 *   repository skills its runner reports. A Skill imported after the start is
 *   not listed until the session is resumed.
 * - A draft lists the current library and reads the repository part from the
 *   repo's main workspace on the chosen runner.
 * - A repository part that cannot be read keeps the library part and says why.
 * - The skipped folders the runner reports are passed through, and a draft
 *   with several repos shows the paths and collisions of the Thread's
 *   workspace.
 * - `session.read` gates the session form and `workspace.read` the draft.
 */
import { describe, expect, it, vi } from "vitest";
import type { RepositorySkill } from "@hercule/protocol";
import { REPOSITORY_SKILLS_CAPABILITY, describeDuplicateCheckoutName } from "@hercule/protocol";
import type { Runner, SessionSkillList } from "@hercule/contract";
import { Effect } from "effect";
import { get, post } from "../../http/testing";
import { withTransaction } from "../../db";
import {
  CURRENT_CAPABILITIES,
  spawnSessionOrFail,
  spawnThreadWithGrants,
  waitForFrames,
  waitForRunnerGone,
  waitUntil,
  WAIT_DEADLINE_MS,
  type Arranged,
} from "../../sessions/testing";
import { importTestSkill } from "../../skills/testing";
import {
  createRepo,
  endResumable,
  listFramesTagged,
  provisionWorkspaceOrFail,
  reportWorkspaceReady,
  spawnThread,
  withFleet,
} from "../../workspaces/testing";

vi.setConfig({ testTimeout: WAIT_DEADLINE_MS * 2 + 10_000 });

/** A well-formed id that no record has. */
const MISSING_ID = "0199e0e7-9999-7000-8000-000000000000";
const REMOTE = "https://fixture.invalid/acme/hercule";

/** Builds a skill the fake runner finds in a checkout called `hercule`. */
const buildRepositorySkill = (name: string, folder = ".agents/skills"): RepositorySkill => ({
  checkoutName: "hercule",
  name,
  description: `Does ${name}.`,
  path: `${folder}/${name}`,
});

const querySkills = async (arranged: Arranged, sessionId: string): Promise<SessionSkillList> => {
  const response = await get(
    arranged.harness.base,
    `/api/v1/sessions/${sessionId}/skills`,
    arranged.token,
  );
  expect(response.status, await response.clone().text()).toBe(200);
  return (await response.json()) as SessionSkillList;
};

const previewSkills = async (arranged: Arranged, query: string): Promise<SessionSkillList> => {
  const response = await get(
    arranged.harness.base,
    `/api/v1/sessions/preview-skills?${query}`,
    arranged.token,
  );
  expect(response.status, await response.clone().text()).toBe(200);
  return (await response.json()) as SessionSkillList;
};

/** Forgets the library skills a session was recorded with, as a session from before the record has. */
const forgetLibrarySkills = (arranged: Arranged, sessionId: string): Promise<unknown> =>
  Effect.runPromise(
    Effect.orDie(
      withTransaction(
        arranged.harness.sql,
        arranged.harness.sql`
        UPDATE sessions SET library_skills = NULL
        WHERE id = unhex(replace(${sessionId}, '-', ''))`,
      ),
    ),
  );

/** Provisions the repo's main workspace on the fleet's runner and waits until it is ready. */
const provisionReadyPrimary = async (arranged: Arranged, resourceId: string): Promise<string> => {
  const workspace = await provisionWorkspaceOrFail(arranged, {
    resourceId,
    runnerId: arranged.runnerId,
  });
  await reportWorkspaceReady(arranged, workspace.id);
  return workspace.id;
};

describe("session.querySkills", () => {
  it("lists the library skills of its last start and the repository skills of its runner, and shows a Skill imported later only after a resume", async () => {
    await withFleet(async (arranged) => {
      const { base } = arranged.harness;
      await importTestSkill(base, arranged.token, "teach");
      arranged.wire.setRepositorySkillsAnswer(() => ({
        status: "listed",
        skills: [buildRepositorySkill("release"), buildRepositorySkill("audit", ".claude/skills")],
        skipped: [],
      }));
      const resourceId = await createRepo(arranged, REMOTE);
      const session = await spawnThread(
        arranged,
        { kind: "ephemeral", checkouts: [{ resourceId }] },
        1,
      );

      expect(await querySkills(arranged, session.id)).toEqual({
        items: [
          { source: "library", name: "teach", description: "Teaches." },
          {
            source: "repository",
            name: "hercule:audit",
            description: "Does audit.",
            path: ".claude/skills/audit",
          },
          {
            source: "repository",
            name: "hercule:release",
            description: "Does release.",
            path: ".agents/skills/release",
          },
        ],
        skipped: [],
      });
      const asked = listFramesTagged(arranged.wire, "repositorySkillsInspect");
      expect(asked.map((frame) => frame["workspaceId"])).toEqual([session.workspaceId]);

      // A Skill imported after the start is not on the session's disk.
      await importTestSkill(base, arranged.token, "implement");
      expect((await querySkills(arranged, session.id)).items.map((item) => item.name)).toEqual([
        "teach",
        "hercule:audit",
        "hercule:release",
      ]);

      await endResumable(arranged, session);
      const resumed = await post(
        base,
        `/api/v1/sessions/${session.id}/input`,
        { text: "again" },
        arranged.token,
      );
      expect(resumed.status, await resumed.clone().text()).toBe(200);
      await waitForFrames(arranged.wire, "sessionStart", 2);
      expect((await querySkills(arranged, session.id)).items.map((item) => item.name)).toEqual([
        "implement",
        "teach",
        "hercule:audit",
        "hercule:release",
      ]);
    });
  });

  it("keeps the library part and says why when the runner fails to list the repository skills", async () => {
    await withFleet(async (arranged) => {
      await importTestSkill(arranged.harness.base, arranged.token, "teach");
      arranged.wire.setRepositorySkillsAnswer(() => ({
        status: "failed",
        message: "the workspace folder is gone",
      }));
      const resourceId = await createRepo(arranged, REMOTE);
      const session = await spawnThread(
        arranged,
        { kind: "ephemeral", checkouts: [{ resourceId }] },
        1,
      );

      const list = await querySkills(arranged, session.id);

      expect(list.items).toEqual([{ source: "library", name: "teach", description: "Teaches." }]);
      expect(list.incompleteReason).toContain("the workspace folder is gone");
    });
  });

  it("passes the skipped folders of the runner through unchanged", async () => {
    await withFleet(async (arranged) => {
      arranged.wire.setRepositorySkillsAnswer(() => ({
        status: "listed",
        skills: [buildRepositorySkill("release")],
        skipped: [{ path: ".agents/skills/broken", reason: "SKILL.md has no description" }],
      }));
      const resourceId = await createRepo(arranged, REMOTE);
      const session = await spawnThread(
        arranged,
        { kind: "ephemeral", checkouts: [{ resourceId }] },
        1,
      );

      const list = await querySkills(arranged, session.id);

      expect(list.skipped).toEqual([
        { path: ".agents/skills/broken", reason: "SKILL.md has no description" },
      ]);
      expect(list.incompleteReason).toBeUndefined();
    });
  });

  it("lists no library skills and says why for a started session that has no record of them", async () => {
    await withFleet(async (arranged) => {
      await importTestSkill(arranged.harness.base, arranged.token, "teach");
      arranged.wire.setRepositorySkillsAnswer(() => ({
        status: "listed",
        skills: [buildRepositorySkill("release")],
        skipped: [],
      }));
      const resourceId = await createRepo(arranged, REMOTE);
      const session = await spawnThread(
        arranged,
        { kind: "ephemeral", checkouts: [{ resourceId }] },
        1,
      );
      await forgetLibrarySkills(arranged, session.id);

      const list = await querySkills(arranged, session.id);

      expect(list.items.map((item) => item.name)).toEqual(["hercule:release"]);
      expect(list.incompleteReason).toContain("started before");
    });
  });

  it("lists today's library without a warning for a session that has not started yet", async () => {
    await withFleet(async (arranged) => {
      await importTestSkill(arranged.harness.base, arranged.token, "teach");
      arranged.wire.setRepositorySkillsAnswer(() => ({
        status: "listed",
        skills: [],
        skipped: [],
      }));
      const resourceId = await createRepo(arranged, REMOTE);
      // The new workspace is never reported ready, so the start is never claimed.
      const session = await spawnSessionOrFail(arranged, {
        prompt: "hello",
        workspace: { kind: "ephemeral", checkouts: [{ resourceId }] },
      });
      expect(session.status).toBe("queued");
      await forgetLibrarySkills(arranged, session.id);
      await importTestSkill(arranged.harness.base, arranged.token, "implement");

      const list = await querySkills(arranged, session.id);

      expect(list.items.map((item) => item.name)).toEqual(["implement", "teach"]);
      expect(list.incompleteReason).toBeUndefined();
    });
  });

  it("joins the missing library record and an unreadable repository part into one message", async () => {
    await withFleet(async (arranged) => {
      arranged.wire.setRepositorySkillsAnswer(() => ({
        status: "failed",
        message: "the workspace folder is gone",
      }));
      const resourceId = await createRepo(arranged, REMOTE);
      const session = await spawnThread(
        arranged,
        { kind: "ephemeral", checkouts: [{ resourceId }] },
        1,
      );
      await forgetLibrarySkills(arranged, session.id);

      const list = await querySkills(arranged, session.id);

      expect(list.items).toEqual([]);
      expect(list.incompleteReason).toContain("started before");
      expect(list.incompleteReason).toContain("the workspace folder is gone");
    });
  });

  it("refuses a caller with skill.read but not session.read", async () => {
    await withFleet(async (arranged) => {
      arranged.wire.setRepositorySkillsAnswer(() => ({
        status: "listed",
        skills: [],
        skipped: [],
      }));
      const resourceId = await createRepo(arranged, REMOTE);
      const session = await spawnThread(
        arranged,
        { kind: "ephemeral", checkouts: [{ resourceId }] },
        1,
      );
      const { token } = await spawnThreadWithGrants(arranged, "skill-reader", ["skill.read"]);
      const reader = await spawnThreadWithGrants(arranged, "session-reader", ["session.read"]);

      const refused = await get(
        arranged.harness.base,
        `/api/v1/sessions/${session.id}/skills`,
        token,
      );

      expect(refused.status).toBe(403);
      expect(await refused.json()).toMatchObject({
        error: { code: "forbidden", details: { grant: "session.read" } },
      });
      const allowed = await get(
        arranged.harness.base,
        `/api/v1/sessions/${session.id}/skills`,
        reader.token,
      );

      expect(allowed.status, await allowed.clone().text()).toBe(200);
    });
  });

  it("answers not found for a session that does not exist", async () => {
    await withFleet(async (arranged) => {
      const response = await get(
        arranged.harness.base,
        `/api/v1/sessions/${MISSING_ID}/skills`,
        arranged.token,
      );

      expect(response.status).toBe(404);
    });
  });
});

describe("session.previewSkills", () => {
  it("lists the current library and the skills of the repo's main workspace on the chosen runner", async () => {
    await withFleet(async (arranged) => {
      await importTestSkill(arranged.harness.base, arranged.token, "teach");
      const resourceId = await createRepo(arranged, REMOTE);
      const primaryId = await provisionReadyPrimary(arranged, resourceId);
      arranged.wire.setRepositorySkillsAnswer((request) =>
        request.workspaceId === primaryId
          ? { status: "listed", skills: [buildRepositorySkill("release")], skipped: [] }
          : { status: "failed", message: "not the main workspace" },
      );

      const list = await previewSkills(
        arranged,
        `runnerId=${arranged.runnerId}&resourceId=${resourceId}`,
      );

      expect(list.items.map((item) => item.name)).toEqual(["teach", "hercule:release"]);
      expect(list.incompleteReason).toBeUndefined();
      expect(
        listFramesTagged(arranged.wire, "repositorySkillsInspect").map(
          (frame) => frame["workspaceId"],
        ),
      ).toEqual([primaryId]);
    });
  });

  it("puts the repo name before the paths when the draft has several repos, and keeps the first of two that share a prefix", async () => {
    await withFleet(async (arranged) => {
      const web = await createRepo(arranged, "https://fixture.invalid/acme/web");
      const dotted = await createRepo(arranged, "https://fixture.invalid/acme/foo.js");
      const hyphenated = await createRepo(arranged, "https://fixture.invalid/acme/foo-js");
      const ids = new Map([
        [await provisionReadyPrimary(arranged, web), "web"],
        [await provisionReadyPrimary(arranged, dotted), "foo-js"],
        [await provisionReadyPrimary(arranged, hyphenated), "foo-js"],
      ]);
      arranged.wire.setRepositorySkillsAnswer((request) => {
        const checkoutName = ids.get(request.workspaceId);
        return checkoutName === undefined
          ? { status: "failed", message: "unknown workspace" }
          : {
              status: "listed",
              skills: [{ ...buildRepositorySkill("release"), checkoutName }],
              skipped: [{ path: ".agents/skills/broken", reason: "no description" }],
            };
      });

      const list = await previewSkills(
        arranged,
        `runnerId=${arranged.runnerId}&resourceId=${web}&resourceId=${dotted}&resourceId=${hyphenated}`,
      );

      expect(list.items).toEqual([
        {
          source: "repository",
          name: "foo-js:release",
          description: "Does release.",
          path: "foo.js/.agents/skills/release",
        },
        {
          source: "repository",
          name: "web:release",
          description: "Does release.",
          path: "web/.agents/skills/release",
        },
      ]);
      expect(list.skipped).toEqual([
        { path: "web/.agents/skills/broken", reason: "no description" },
        { path: "foo.js/.agents/skills/broken", reason: "no description" },
        {
          path: "foo-js/.agents/skills/release",
          reason: describeDuplicateCheckoutName("foo-js"),
        },
        { path: "foo-js/.agents/skills/broken", reason: "no description" },
      ]);
    });
  });

  it("refuses a caller without workspace.read, and a caller with it is allowed", async () => {
    await withFleet(async (arranged) => {
      const resourceId = await createRepo(arranged, REMOTE);
      const query = `runnerId=${arranged.runnerId}&resourceId=${resourceId}`;
      const skillReader = await spawnThreadWithGrants(arranged, "skill-reader", ["skill.read"]);
      const workspaceReader = await spawnThreadWithGrants(arranged, "workspace-reader", [
        "workspace.read",
      ]);

      const refused = await get(
        arranged.harness.base,
        `/api/v1/sessions/preview-skills?${query}`,
        skillReader.token,
      );

      expect(refused.status).toBe(403);
      expect(await refused.json()).toMatchObject({
        error: { code: "forbidden", details: { grant: "workspace.read" } },
      });

      const allowed = await get(
        arranged.harness.base,
        `/api/v1/sessions/preview-skills?${query}`,
        workspaceReader.token,
      );

      expect(allowed.status, await allowed.clone().text()).toBe(200);
    });
  });

  it("refuses a draft without a runner or without a repo", async () => {
    await withFleet(async (arranged) => {
      const resourceId = await createRepo(arranged, REMOTE);

      const noResource = await get(
        arranged.harness.base,
        `/api/v1/sessions/preview-skills?runnerId=${arranged.runnerId}`,
        arranged.token,
      );
      const noRunner = await get(
        arranged.harness.base,
        `/api/v1/sessions/preview-skills?resourceId=${resourceId}`,
        arranged.token,
      );

      expect(noResource.status).toBe(400);
      expect(noRunner.status).toBe(400);
    });
  });

  it("answers not found for a repo that does not exist", async () => {
    await withFleet(async (arranged) => {
      const response = await get(
        arranged.harness.base,
        `/api/v1/sessions/preview-skills?runnerId=${arranged.runnerId}&resourceId=${MISSING_ID}`,
        arranged.token,
      );

      expect(response.status).toBe(404);
    });
  });

  it("says a repo has no main workspace on a runner that has none", async () => {
    await withFleet(async (arranged) => {
      await importTestSkill(arranged.harness.base, arranged.token, "teach");
      const resourceId = await createRepo(arranged, REMOTE);
      const second = await arranged.enlist();

      const list = await previewSkills(
        arranged,
        `runnerId=${second.runnerId}&resourceId=${resourceId}`,
      );

      expect(list.items).toEqual([{ source: "library", name: "teach", description: "Teaches." }]);
      expect(list.incompleteReason).toContain("acme/hercule");
      expect(listFramesTagged(second.wire, "repositorySkillsInspect")).toEqual([]);
    });
  });

  it("keeps the library part and asks nothing of a runner too old to list repository skills", async () => {
    await withFleet(async (arranged) => {
      await importTestSkill(arranged.harness.base, arranged.token, "teach");
      const resourceId = await createRepo(arranged, REMOTE);
      await provisionReadyPrimary(arranged, resourceId);
      arranged.wire.close();
      await waitForRunnerGone(arranged);
      const older = await arranged.reconnect({
        capabilities: CURRENT_CAPABILITIES.filter(
          (capability) => capability !== REPOSITORY_SKILLS_CAPABILITY,
        ),
      });
      older.send({ _tag: "sessionsReport", sessions: [] });
      await waitUntil("negotiated the older runner's capabilities", async () => {
        const response = await get(
          arranged.harness.base,
          `/api/v1/runners/${arranged.runnerId}`,
          arranged.token,
        );
        const runner = (await response.json()) as Runner & {
          readonly negotiatedCapabilities: ReadonlyArray<string> | null;
        };
        return runner.connectivity === "online" &&
          runner.negotiatedCapabilities?.includes(REPOSITORY_SKILLS_CAPABILITY) === false
          ? true
          : undefined;
      });

      const list = await previewSkills(
        arranged,
        `runnerId=${arranged.runnerId}&resourceId=${resourceId}`,
      );

      expect(list.items).toEqual([{ source: "library", name: "teach", description: "Teaches." }]);
      expect(list.incompleteReason).toContain("too old");
      expect(listFramesTagged(older, "repositorySkillsInspect")).toEqual([]);
    });
  });
});
