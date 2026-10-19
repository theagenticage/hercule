/**
 * Integration tests for `session.querySkills` and `session.previewSkills`, driven over HTTP against a
 * controller with a fake runner on the real runner socket. The fake runner
 * answers `repositorySkillsInspect` (a session) and `repositorySkillsPreview`
 * (a draft) with the listing it is told to give; the runner owns every listing
 * rule, so the controller must pass the answer on as it is.
 *
 * What the tests check:
 *
 * - A session lists the library skills it got at its last start, then the
 *   repository skills its runner reports. A Skill imported after the start is
 *   not listed until the session is resumed.
 * - A session that is queued, also one resumed after a run, lists the library
 *   its next start will get.
 * - A draft lists the current library and asks the runner, in one frame, for
 *   the repos in the order the Thread would open them.
 * - A repository part that cannot be read keeps the library part and says why.
 * - The skipped folders the runner reports are passed through, and so is a
 *   listing that stopped at the runner's caps, which is said in
 *   `incompleteReason`.
 * - A draft whose resources cannot be checked out together is refused with the same
 *   status and message as the spawn of that Thread.
 * - `session.read` gates the session form and `workspace.read` the draft.
 */
import { describe, expect, it, vi } from "vitest";
import type { RepositorySkill, RepositorySkillsInspection } from "@hercule/protocol";
import { REPOSITORY_SKILLS_CAPABILITY } from "@hercule/protocol";
import type { Runner, SessionSkillList } from "@hercule/contract";
import { Effect } from "effect";
import { get, post, send } from "../../http/testing";
import { withTransaction } from "../../db";
import {
  CURRENT_CAPABILITIES,
  spawnSession,
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

/** Builds the outcome of a runner that listed these skills. */
const buildListed = (
  skills: ReadonlyArray<RepositorySkill>,
  skipped: ReadonlyArray<{ readonly path: string; readonly reason: string }> = [],
  truncated = false,
): RepositorySkillsInspection["outcome"] => ({ status: "listed", skills, skipped, truncated });

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

/** Creates a repo for the remote, or a folder when the remote is `null`, and returns its id. */
const createRepoOrFolder = async (arranged: Arranged, remote: string | null): Promise<string> => {
  if (remote !== null) return createRepo(arranged, remote);
  const response = await post(
    arranged.harness.base,
    "/api/v1/resources",
    { kind: "folder", label: "Notes" },
    arranged.token,
  );
  expect([200, 201], await response.clone().text()).toContain(response.status);
  return ((await response.json()) as { id: string }).id;
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
      arranged.wire.setRepositorySkillsAnswer(() =>
        buildListed([
          buildRepositorySkill("release"),
          buildRepositorySkill("audit", ".claude/skills"),
        ]),
      );
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
      arranged.wire.setRepositorySkillsAnswer(() =>
        buildListed(
          [buildRepositorySkill("release")],
          [{ path: ".agents/skills/broken", reason: "SKILL.md has no description" }],
        ),
      );
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
      arranged.wire.setRepositorySkillsAnswer(() => buildListed([buildRepositorySkill("release")]));
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
      arranged.wire.setRepositorySkillsAnswer(() => buildListed([]));
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

  it("says in incompleteReason that the runner stopped at its caps, and keeps what it listed", async () => {
    await withFleet(async (arranged) => {
      arranged.wire.setRepositorySkillsAnswer(() =>
        buildListed([buildRepositorySkill("release")], [], true),
      );
      const resourceId = await createRepo(arranged, REMOTE);
      const session = await spawnThread(
        arranged,
        { kind: "ephemeral", checkouts: [{ resourceId }] },
        1,
      );

      const list = await querySkills(arranged, session.id);

      expect(list.items.map((item) => item.name)).toEqual(["hercule:release"]);
      expect(list.incompleteReason).toContain("Not every skill folder of the workspace is shown");
      expect(list.incompleteReason).toContain("256");
    });
  });

  it("lists the library its next start will get for a session resumed into the queue, not the one of its previous start", async () => {
    await withFleet(async (arranged) => {
      const { base } = arranged.harness;
      await importTestSkill(base, arranged.token, "old");
      arranged.wire.setRepositorySkillsAnswer(() => buildListed([]));
      const resourceId = await createRepo(arranged, REMOTE);
      const session = await spawnThread(
        arranged,
        { kind: "ephemeral", checkouts: [{ resourceId }] },
        1,
      );
      await endResumable(arranged, session);
      // The runner's only slot is taken, so the resumed session waits in the queue.
      const capped = await send("PATCH", base, `/api/v1/runners/${arranged.runnerId}`, {
        body: { maxConcurrentSessions: 1 },
        token: arranged.token,
      });
      expect(capped.status, await capped.clone().text()).toBe(200);
      await spawnSessionOrFail(arranged, { prompt: "take the slot" });
      await waitForFrames(arranged.wire, "sessionStart", 2);
      await importTestSkill(base, arranged.token, "new");

      const resumed = await post(
        base,
        `/api/v1/sessions/${session.id}/input`,
        { text: "again" },
        arranged.token,
      );
      expect(resumed.status, await resumed.clone().text()).toBe(200);

      expect((await querySkills(arranged, session.id)).items.map((item) => item.name)).toEqual([
        "new",
        "old",
      ]);
    });
  });

  it("refuses a caller with skill.read but not session.read", async () => {
    await withFleet(async (arranged) => {
      arranged.wire.setRepositorySkillsAnswer(() => buildListed([]));
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
  it("lists the current library and what the runner lists for the repo's main workspace", async () => {
    await withFleet(async (arranged) => {
      await importTestSkill(arranged.harness.base, arranged.token, "teach");
      const resourceId = await createRepo(arranged, REMOTE);
      const primaryId = await provisionReadyPrimary(arranged, resourceId);
      arranged.wire.setRepositorySkillsPreviewAnswer(() =>
        buildListed([buildRepositorySkill("release")]),
      );

      const list = await previewSkills(
        arranged,
        `runnerId=${arranged.runnerId}&resourceId=${resourceId}`,
      );

      expect(list.items.map((item) => item.name)).toEqual(["teach", "hercule:release"]);
      expect(list.incompleteReason).toBeUndefined();
      expect(
        listFramesTagged(arranged.wire, "repositorySkillsPreview").map(
          (frame) => frame["checkouts"],
        ),
      ).toEqual([[{ remote: REMOTE, subdirectory: null, workspaceId: primaryId }]]);
      expect(listFramesTagged(arranged.wire, "repositorySkillsInspect")).toEqual([]);
    });
  });

  it("asks once for several repos, in order, with the directory each would get and null for a repo without a ready main workspace", async () => {
    await withFleet(async (arranged) => {
      const web = await createRepo(arranged, "https://fixture.invalid/acme/web");
      const api = await createRepo(arranged, "https://fixture.invalid/acme/api");
      const webPrimary = await provisionReadyPrimary(arranged, web);
      arranged.wire.setRepositorySkillsPreviewAnswer(() =>
        buildListed(
          [
            {
              ...buildRepositorySkill("release"),
              checkoutName: "web",
              path: "web/.agents/skills/release",
            },
          ],
          [{ path: "api/.agents/skills", reason: "no ready workspace" }],
        ),
      );

      const list = await previewSkills(
        arranged,
        `runnerId=${arranged.runnerId}&resourceId=${web}&resourceId=${api}`,
      );

      expect(
        listFramesTagged(arranged.wire, "repositorySkillsPreview").map(
          (frame) => frame["checkouts"],
        ),
      ).toEqual([
        [
          {
            remote: "https://fixture.invalid/acme/web",
            subdirectory: "web",
            workspaceId: webPrimary,
          },
          { remote: "https://fixture.invalid/acme/api", subdirectory: "api", workspaceId: null },
        ],
      ]);
      // The runner's answer is passed on as it is: names, paths and skipped entries.
      expect(list.items).toEqual([
        {
          source: "repository",
          name: "web:release",
          description: "Does release.",
          path: "web/.agents/skills/release",
        },
      ]);
      expect(list.skipped).toEqual([{ path: "api/.agents/skills", reason: "no ready workspace" }]);
    });
  });

  it("says in incompleteReason that the runner stopped at its caps", async () => {
    await withFleet(async (arranged) => {
      const resourceId = await createRepo(arranged, REMOTE);
      await provisionReadyPrimary(arranged, resourceId);
      arranged.wire.setRepositorySkillsPreviewAnswer(() =>
        buildListed([buildRepositorySkill("release")], [], true),
      );

      const list = await previewSkills(
        arranged,
        `runnerId=${arranged.runnerId}&resourceId=${resourceId}`,
      );

      expect(list.items.map((item) => item.name)).toEqual(["hercule:release"]);
      expect(list.incompleteReason).toContain("Not every skill folder of the workspace is shown");
    });
  });

  it("keeps the library part and says why when the runner fails to list", async () => {
    await withFleet(async (arranged) => {
      await importTestSkill(arranged.harness.base, arranged.token, "teach");
      const resourceId = await createRepo(arranged, REMOTE);
      await provisionReadyPrimary(arranged, resourceId);
      arranged.wire.setRepositorySkillsPreviewAnswer(() => ({
        status: "failed",
        message: "the disk is full",
      }));

      const list = await previewSkills(
        arranged,
        `runnerId=${arranged.runnerId}&resourceId=${resourceId}`,
      );

      expect(list.items).toEqual([{ source: "library", name: "teach", description: "Teaches." }]);
      expect(list.incompleteReason).toContain("the disk is full");
    });
  });

  it.each([
    {
      refusal: "a repo listed twice",
      remotes: ["https://fixture.invalid/acme/web"],
      listing: [0, 0],
      message: "list each repo once",
    },
    {
      refusal: "two repos with the same name",
      remotes: ["https://fixture.invalid/acme/web", "https://fixture.invalid/other/web"],
      listing: [0, 1],
      message: "have the same name",
    },
    {
      refusal: "a resource that is not a repo",
      remotes: ["https://fixture.invalid/acme/web", null],
      listing: [0, 1],
      message: "only a repo is checked out",
    },
    {
      refusal: "a repo name that is not a valid directory name",
      remotes: ["https://fixture.invalid/acme/web", "https://fixture.invalid/acme/caf%C3%A9"],
      listing: [0, 1],
      message: "not a valid directory name",
    },
    {
      refusal: "a repo named .claude beside another repo",
      remotes: ["https://fixture.invalid/acme/web", "https://fixture.invalid/acme/.claude"],
      listing: [0, 1],
      message: "folder at the workspace root",
    },
    {
      refusal: "a repo named .Agents beside another repo",
      remotes: ["https://fixture.invalid/acme/.Agents", "https://fixture.invalid/acme/web"],
      listing: [0, 1],
      message: "folder at the workspace root",
    },
  ])(
    "refuses $refusal with the status and message of the spawn",
    async ({ remotes, listing, message }) => {
      await withFleet(async (arranged) => {
        // A remote of `null` stands for a folder, which is not a repo.
        const ids: Array<string> = [];
        for (const remote of remotes) ids.push(await createRepoOrFolder(arranged, remote));
        const resourceIds = listing.map((index) => ids[index]!);

        const spawned = await spawnSession(arranged, {
          prompt: "hello",
          workspace: {
            kind: "ephemeral",
            checkouts: resourceIds.map((resourceId) => ({ resourceId })),
          },
        });
        const previewed = await get(
          arranged.harness.base,
          `/api/v1/sessions/preview-skills?runnerId=${arranged.runnerId}&${resourceIds
            .map((resourceId) => `resourceId=${resourceId}`)
            .join("&")}`,
          arranged.token,
        );

        expect(spawned.status).toBe(400);
        expect(previewed.status).toBe(400);
        const spawnedError = ((await spawned.json()) as { error: unknown }).error;
        const previewedError = ((await previewed.json()) as { error: unknown }).error;
        expect(previewedError).toEqual(spawnedError);
        expect(spawnedError).toMatchObject({ code: "validation" });
        expect(JSON.stringify(spawnedError)).toContain(message);
        expect(listFramesTagged(arranged.wire, "repositorySkillsPreview")).toEqual([]);
      });
    },
  );

  it("accepts a single repo named .claude, because a single repo is the workspace root and has no directory", async () => {
    await withFleet(async (arranged) => {
      const resourceId = await createRepo(arranged, "https://fixture.invalid/acme/.claude");
      arranged.wire.setRepositorySkillsPreviewAnswer(() => buildListed([]));

      await previewSkills(arranged, `runnerId=${arranged.runnerId}&resourceId=${resourceId}`);
      const spawned = await spawnSession(arranged, {
        prompt: "hello",
        workspace: { kind: "ephemeral", checkouts: [{ resourceId }] },
      });

      expect(spawned.status, await spawned.clone().text()).toBeLessThan(300);
      expect(
        listFramesTagged(arranged.wire, "repositorySkillsPreview").map(
          (frame) => frame["checkouts"],
        ),
      ).toEqual([
        [
          {
            remote: "https://fixture.invalid/acme/.claude",
            subdirectory: null,
            workspaceId: null,
          },
        ],
      ]);
    });
  });

  it("refuses a caller without workspace.read, and a caller with it is allowed", async () => {
    await withFleet(async (arranged) => {
      const resourceId = await createRepo(arranged, REMOTE);
      arranged.wire.setRepositorySkillsPreviewAnswer(() => buildListed([]));
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

  it("sends null for a repo that has no main workspace on the runner and passes the runner's reason on", async () => {
    await withFleet(async (arranged) => {
      await importTestSkill(arranged.harness.base, arranged.token, "teach");
      const resourceId = await createRepo(arranged, REMOTE);
      const second = await arranged.enlist();
      second.wire.setRepositorySkillsPreviewAnswer(() =>
        buildListed([], [{ path: ".agents/skills", reason: "no ready main workspace here" }]),
      );

      const list = await previewSkills(
        arranged,
        `runnerId=${second.runnerId}&resourceId=${resourceId}`,
      );

      expect(
        listFramesTagged(second.wire, "repositorySkillsPreview").map((frame) => frame["checkouts"]),
      ).toEqual([[{ remote: REMOTE, subdirectory: null, workspaceId: null }]]);
      expect(list.items).toEqual([{ source: "library", name: "teach", description: "Teaches." }]);
      expect(list.skipped).toEqual([
        { path: ".agents/skills", reason: "no ready main workspace here" },
      ]);
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
      expect(listFramesTagged(older, "repositorySkillsPreview")).toEqual([]);
    });
  });
});
