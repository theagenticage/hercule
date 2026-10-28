/**
 * Tests the update of a Skill from its GitHub source over HTTP, against a
 * real controller that reads a fake GitHub:
 *
 * - `skill.check` answers at once, and the check's result reaches the Skill
 *   and the `skill` live topic once it ends;
 * - the update waits until `skill.apply`, and a Thread started after the
 *   apply gets the new revision;
 * - the periodic check finds an update without anyone asking.
 */
import { describe, expect, it } from "vitest";
import { Duration, Effect, Fiber } from "effect";
import type { LiveMessage, Skill, SkillDetail } from "@hercule/contract";
import { computeSkillRevisionHash, type SkillFile } from "@hercule/protocol";
import * as SqlClient from "effect/sql/SqlClient";
import {
  collectPushes,
  completeSetup,
  expectHeld,
  fetchTicket,
  get,
  onSocket,
  post,
  waitForLiveToSettle,
  waitWithin,
  withServer,
  type ServerHarness,
} from "../http/testing";
import { decideSessionSkills } from "./session-skills";
import { importTestSkill, makeFakeGithub } from "./testing";

const SOURCE = { repo: "acme/skills", path: "skills/teach" } as const;
const COMMIT = "1".repeat(40);

/** The files of the skill `teach` with `body` as its `SKILL.md` body, as `importTestSkill` builds them. */
const buildTeachFiles = (body: string): ReadonlyArray<SkillFile> => [
  {
    path: "SKILL.md",
    mode: "644",
    content: new TextEncoder().encode(`---\nname: teach\ndescription: Teaches.\n---\n${body}\n`),
  },
];

const readTeach = async (harness: ServerHarness, token: string): Promise<SkillDetail> => {
  const response = await get(harness.base, "/api/v1/skills/teach", token);
  expect(response.status).toBe(200);
  return (await response.json()) as SkillDetail;
};

/**
 * Subscribes to the `skill` topic, runs `act`, and returns once a push names
 * `teach` after it. Fails the test when none arrives within two seconds.
 */
const awaitTeachPush = async (
  harness: ServerHarness,
  token: string,
  act: () => Promise<void>,
): Promise<void> => {
  // So a push the import before left in flight is not taken for the one `act` causes.
  await waitForLiveToSettle();
  const ticket = await fetchTicket(harness.base, token);
  await onSocket(harness.base, (client) =>
    Effect.gen(function* () {
      yield* client.hello({ v: 1, ticket });
      const pushes = yield* collectPushes(client, "skill");
      yield* Effect.promise(() => expectHeld(harness.live, 1, "skill"));
      yield* Effect.promise(act);
      const namesTeach = (message: LiveMessage) =>
        message._tag === "invalidate" && message.ids.includes("teach");
      expect(
        yield* Effect.promise(() => waitWithin(2000, () => pushes.received.some(namesTeach))),
      ).toBe(true);
      yield* Fiber.interrupt(pushes.fiber);
    }),
  );
};

describe("updating a Skill from GitHub", () => {
  it("finds an upstream change on request, and gives it to Threads only once it is applied", async () => {
    const github = makeFakeGithub();
    const upstream = buildTeachFiles("Upstream");
    const upstreamHash = await Effect.runPromise(computeSkillRevisionHash(upstream));
    await withServer(
      async (harness) => {
        const token = await completeSetup(harness.base);
        const imported = await importTestSkill(harness.base, token, "teach", { source: SOURCE });
        github.pushCommit(COMMIT, { [SOURCE.path]: upstream });

        await awaitTeachPush(harness, token, async () => {
          const response = await post(
            harness.base,
            "/api/v1/skills/check",
            { name: "teach" },
            token,
          );
          expect(response.status).toBe(200);
          expect(await response.json()).toEqual({});
        });
        const checked = await readTeach(harness, token);
        expect(checked.skill).toMatchObject({
          currentRevisionHash: imported.currentRevisionHash,
          availableRevisionHash: upstreamHash,
          checkError: null,
        });

        const sessionSkills = () =>
          Effect.runPromise(
            Effect.provideService(
              decideSessionSkills({ agentId: null }),
              SqlClient.SqlClient,
              harness.sql,
            ),
          );
        expect(await sessionSkills()).toMatchObject([
          { name: "teach", revisionHash: imported.currentRevisionHash },
        ]);

        const applied = await post(
          harness.base,
          `/api/v1/skills/teach/revisions/${upstreamHash}/apply`,
          {},
          token,
        );
        expect(applied.status, await applied.clone().text()).toBe(200);
        expect(((await applied.json()) as Skill).currentRevisionHash).toBe(upstreamHash);
        expect(await sessionSkills()).toMatchObject([
          { name: "teach", revisionHash: upstreamHash },
        ]);
        expect(await harness.audit("skill.applied")).toHaveLength(1);
      },
      { githubSkillSources: github.service },
    );
  });

  it("checks a GitHub Skill on its own, without a request", async () => {
    const github = makeFakeGithub();
    github.pushCommit(COMMIT, { [SOURCE.path]: buildTeachFiles("Upstream") });
    await withServer(
      async (harness) => {
        const token = await completeSetup(harness.base);
        await importTestSkill(harness.base, token, "teach", { source: SOURCE });
        let detail = await readTeach(harness, token);
        const deadline = Date.now() + 2000;
        while (detail.skill.availableRevisionHash === null && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 10));
          detail = await readTeach(harness, token);
        }
        expect(detail.skill.availableRevisionHash).not.toBeNull();
        expect(detail.skill.lastCheckedAt).not.toBeNull();
      },
      { githubSkillSources: github.service, skillUpdateCheckInterval: Duration.millis(50) },
    );
  });
});
