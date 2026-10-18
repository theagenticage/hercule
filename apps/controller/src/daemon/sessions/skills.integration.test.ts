/**
 * Integration tests for `sessionSkill.query`, driven over HTTP against a
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
 */
import { describe, expect, it, vi } from "vitest";
import type { RepositorySkill } from "@hercule/protocol";
import { REPOSITORY_SKILLS_CAPABILITY } from "@hercule/protocol";
import type { Runner, SessionSkillList } from "@hercule/contract";
import { get, post } from "../../http/testing";
import {
  CURRENT_CAPABILITIES,
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

const REMOTE = "https://fixture.invalid/acme/hercule";

/** Builds a skill the fake runner finds in a checkout called `hercule`. */
const buildRepositorySkill = (name: string, folder = ".agents/skills"): RepositorySkill => ({
  checkoutId: "checkout-1",
  checkoutName: "hercule",
  name,
  description: `Does ${name}.`,
  path: `${folder}/${name}`,
});

const querySkills = async (arranged: Arranged, query: string): Promise<SessionSkillList> => {
  const response = await get(
    arranged.harness.base,
    `/api/v1/session-skills?${query}`,
    arranged.token,
  );
  expect(response.status, await response.clone().text()).toBe(200);
  return (await response.json()) as SessionSkillList;
};

/** Provisions the repo's main workspace on the fleet's runner and waits until it is ready. */
const provisionReadyPrimary = async (arranged: Arranged, resourceId: string): Promise<string> => {
  const workspace = await provisionWorkspaceOrFail(arranged, {
    resourceId,
    runnerId: arranged.runnerId,
  });
  await reportWorkspaceReady(arranged, workspace.id);
  return workspace.id;
};

describe("sessionSkill.query for a session", () => {
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

      expect(await querySkills(arranged, `sessionId=${session.id}`)).toEqual({
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
      });
      const asked = listFramesTagged(arranged.wire, "repositorySkillsInspect");
      expect(asked.map((frame) => frame["workspaceId"])).toEqual([session.workspaceId]);

      // A Skill imported after the start is not on the session's disk.
      await importTestSkill(base, arranged.token, "implement");
      expect(
        (await querySkills(arranged, `sessionId=${session.id}`)).items.map((item) => item.name),
      ).toEqual(["teach", "hercule:audit", "hercule:release"]);

      await endResumable(arranged, session);
      const resumed = await post(
        base,
        `/api/v1/sessions/${session.id}/input`,
        { text: "again" },
        arranged.token,
      );
      expect(resumed.status, await resumed.clone().text()).toBe(200);
      await waitForFrames(arranged.wire, "sessionStart", 2);
      expect(
        (await querySkills(arranged, `sessionId=${session.id}`)).items.map((item) => item.name),
      ).toEqual(["implement", "teach", "hercule:audit", "hercule:release"]);
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

      const list = await querySkills(arranged, `sessionId=${session.id}`);

      expect(list.items).toEqual([{ source: "library", name: "teach", description: "Teaches." }]);
      expect(list.repositorySkillsUnavailable).toContain("the workspace folder is gone");
    });
  });
});

describe("sessionSkill.query for a draft", () => {
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

      const list = await querySkills(
        arranged,
        `runnerId=${arranged.runnerId}&resourceId=${resourceId}`,
      );

      expect(list.items.map((item) => item.name)).toEqual(["teach", "hercule:release"]);
      expect(list.repositorySkillsUnavailable).toBeUndefined();
      expect(
        listFramesTagged(arranged.wire, "repositorySkillsInspect").map(
          (frame) => frame["workspaceId"],
        ),
      ).toEqual([primaryId]);
    });
  });

  it("says a repo has no main workspace on a runner that has none", async () => {
    await withFleet(async (arranged) => {
      await importTestSkill(arranged.harness.base, arranged.token, "teach");
      const resourceId = await createRepo(arranged, REMOTE);
      const second = await arranged.enlist();

      const list = await querySkills(
        arranged,
        `runnerId=${second.runnerId}&resourceId=${resourceId}`,
      );

      expect(list.items).toEqual([{ source: "library", name: "teach", description: "Teaches." }]);
      expect(list.repositorySkillsUnavailable).toContain("acme/hercule");
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

      const list = await querySkills(
        arranged,
        `runnerId=${arranged.runnerId}&resourceId=${resourceId}`,
      );

      expect(list.items).toEqual([{ source: "library", name: "teach", description: "Teaches." }]);
      expect(list.repositorySkillsUnavailable).toContain("too old");
      expect(listFramesTagged(older, "repositorySkillsInspect")).toEqual([]);
    });
  });
});
