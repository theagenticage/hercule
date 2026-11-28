/**
 * Tests the update of a Skill from its GitHub source over HTTP, against a
 * real controller that reads a fake GitHub:
 *
 * - `skill.check` answers at once, and the check's result reaches the Skill
 *   and the `skill` live topic once it ends;
 * - the update waits until `skill.apply`, and a Thread started after the
 *   apply gets the new revision;
 * - the periodic check finds an update without anyone asking.
 *
 * and a session's proposals (spec 11 section 2 `skill`): who may propose,
 * who applies, what taint refuses and where the caps stop a session.
 */
import { describe, expect, it } from "vitest";
import { Duration, Effect, Fiber } from "effect";
import {
  MAX_PROPOSED_SKILL_REVISIONS,
  ONLY_A_SESSION_PROPOSES_SKILLS,
  type LiveMessage,
  type Skill,
  type SkillDetail,
  type SkillProposeResult,
} from "@hercule/contract";
import { buildSkillArchive, computeSkillRevisionHash, type SkillFile } from "@hercule/protocol";
import * as SqlClient from "effect/sql/SqlClient";
import {
  collectPushes,
  completeSetup,
  expectHeld,
  fetchTicket,
  get,
  onSocket,
  post,
  send,
  waitForLiveToSettle,
  waitWithin,
  withServer,
  type ServerHarness,
} from "../http/testing";
import { withPipeline } from "../daemon/testing";
import { withTransaction } from "../db";
import {
  createProfile,
  readProfileNamed,
  spawnThreadUnder,
  spawnThreadWithGrants,
  type Arranged,
} from "../sessions/testing";
import { sessionTaint } from "../taint";
import { decideSessionSkills } from "./session-skills";
import { buildTestSkillArchive, importTestSkill, makeFakeGithub } from "./testing";

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

interface Refusal {
  readonly code: string;
  readonly message: string;
  readonly grant?: string;
}

/** Proposes the skill `name` with `body` as its `SKILL.md` body, as whoever holds `token`. */
const propose = async (
  arranged: Arranged,
  token: string,
  name: string,
  body = "Body",
): Promise<Response> =>
  fetch(`${arranged.harness.base}/api/v1/skills/propose?name=${name}`, {
    method: "POST",
    headers: { "content-type": "application/octet-stream", authorization: `Bearer ${token}` },
    body: await buildTestSkillArchive(name, body),
  });

/** Applies a revision of `name`, as whoever holds `token`. */
const applyRevision = (
  arranged: Arranged,
  token: string,
  name: string,
  revisionHash: string,
): Promise<Response> =>
  post(arranged.harness.base, `/api/v1/skills/${name}/revisions/${revisionHash}/apply`, {}, token);

const readRefusal = async (response: Response): Promise<Refusal> => {
  const { error } = (await response.json()) as {
    readonly error: {
      readonly code: string;
      readonly message: string;
      readonly details?: { readonly grant?: string };
    };
  };
  return {
    code: error.code,
    message: error.message,
    ...(error.details?.grant === undefined ? {} : { grant: error.details.grant }),
  };
};

/** Reads a proposal's answer, failing the test when the proposal was refused. */
const readProposed = async (response: Response): Promise<SkillProposeResult> => {
  expect(response.status, await response.clone().text()).toBe(200);
  return (await response.json()) as SkillProposeResult;
};

describe("a session proposing a Skill", () => {
  it("proposes, waits for the user to apply, and applies a later proposal itself once it holds skill.apply", async () => {
    await withPipeline(async (arranged) => {
      const profile = await createProfile(arranged, "ada", ["skill.read", "skill.write"]);
      const ada = await spawnThreadUnder(arranged, profile);

      const first = await readProposed(await propose(arranged, ada.token, "teach", "First"));
      expect(first).toMatchObject({
        result: "proposed",
        skill: { currentRevisionHash: null, proposedCount: 1 },
      });
      const firstHash = (
        (await (
          await get(arranged.harness.base, "/api/v1/skills/teach", arranged.token)
        ).json()) as SkillDetail
      ).proposedRevisions[0]!.revisionHash;

      const refused = await applyRevision(arranged, ada.token, "teach", firstHash);
      expect(refused.status).toBe(403);
      expect(await readRefusal(refused)).toMatchObject({ grant: "skill.apply" });

      const applied = await applyRevision(arranged, arranged.token, "teach", firstHash);
      expect(applied.status, await applied.clone().text()).toBe(200);
      expect(((await applied.json()) as Skill).currentRevisionHash).toBe(firstHash);

      const widened = await send("PATCH", arranged.harness.base, `/api/v1/profiles/${profile.id}`, {
        body: { grants: ["skill.read", "skill.write", "skill.apply"] },
        token: arranged.token,
      });
      expect(widened.status, await widened.clone().text()).toBe(200);
      await readProposed(await propose(arranged, ada.token, "teach", "Second"));
      const detail = (await (
        await get(arranged.harness.base, "/api/v1/skills/teach", arranged.token)
      ).json()) as SkillDetail;
      const secondHash = detail.proposedRevisions[0]!.revisionHash;
      const appliedByAda = await applyRevision(arranged, ada.token, "teach", secondHash);
      expect(appliedByAda.status, await appliedByAda.clone().text()).toBe(200);
      expect(((await appliedByAda.json()) as Skill).currentRevisionHash).toBe(secondHash);
    });
  });

  it("refuses a Thread on unrestricted, naming skill.write, which it can ask for", async () => {
    await withPipeline(async (arranged) => {
      const thread = await spawnThreadUnder(
        arranged,
        await readProfileNamed(arranged, "unrestricted"),
      );
      const response = await propose(arranged, thread.token, "teach");
      expect(response.status).toBe(403);
      expect(await readRefusal(response)).toMatchObject({
        code: "forbidden",
        grant: "skill.write",
      });

      const asked = await post(
        arranged.harness.base,
        "/api/v1/permissions/request",
        { grant: "skill.write", reason: "I want to propose a skill." },
        thread.token,
      );
      expect(asked.status, await asked.clone().text()).toBe(200);
    });
  });

  it("lists a bad name beside the other broken rules, as an import does", async () => {
    await withPipeline(async (arranged) => {
      const archive = await Effect.runPromise(
        buildSkillArchive([
          {
            path: "SKILL.md",
            mode: "644",
            content: new TextEncoder().encode("---\nname: Release_Checklist\n---\nBody\n"),
          },
        ]),
      );
      const ada = await spawnThreadWithGrants(arranged, "ada", ["skill.write"]);
      const uploadArchive = (url: string, token: string) =>
        fetch(`${arranged.harness.base}${url}?name=Release_Checklist`, {
          method: "POST",
          headers: { "content-type": "application/octet-stream", authorization: `Bearer ${token}` },
          body: archive,
        });
      const readIssues = async (response: Response) => {
        expect(response.status).toBe(400);
        const { error } = (await response.json()) as {
          readonly error: {
            readonly code: string;
            readonly details: { readonly issues: ReadonlyArray<{ readonly message: string }> };
          };
        };
        expect(error.code).toBe("validation");
        return error.details.issues.map((issue) => issue.message);
      };

      const imported = await readIssues(
        await uploadArchive("/api/v1/skills/import", arranged.token),
      );
      const proposed = await readIssues(await uploadArchive("/api/v1/skills/propose", ada.token));

      expect(imported).toHaveLength(2);
      expect(imported.some((message) => message.includes("is not a valid skill name"))).toBe(true);
      expect(imported.some((message) => message.includes("has no `description`"))).toBe(true);
      expect(proposed).toEqual(imported);
    });
  });

  it("refuses the user, with the reason and the way to import instead", async () => {
    await withPipeline(async (arranged) => {
      const response = await propose(arranged, arranged.token, "teach");
      expect(response.status).toBe(403);
      expect(await readRefusal(response)).toEqual({
        code: "forbidden",
        message: ONLY_A_SESSION_PROPOSES_SKILLS,
        grant: "skill.write",
      });
    });
  });

  it("lets a tainted session propose but not apply, and marks its proposal", async () => {
    await withPipeline(async (arranged) => {
      const ada = await spawnThreadWithGrants(arranged, "ada", [
        "skill.read",
        "skill.write",
        "skill.apply",
      ]);
      await Effect.runPromise(
        Effect.flatMap(sessionTaint, (it) =>
          withTransaction(arranged.harness.sql, it.markTainted(ada.session.id)),
        ).pipe(Effect.provideService(SqlClient.SqlClient, arranged.harness.sql)),
      );
      await readProposed(await propose(arranged, ada.token, "teach"));
      const detail = (await (
        await get(arranged.harness.base, "/api/v1/skills/teach", arranged.token)
      ).json()) as SkillDetail;
      const [proposed] = detail.proposedRevisions;
      expect(proposed).toMatchObject({ includesThirdPartyContent: true });

      const refused = await applyRevision(arranged, ada.token, "teach", proposed!.revisionHash);
      expect(refused.status).toBe(403);
      expect(await readRefusal(refused)).toEqual({
        code: "forbidden",
        message:
          "This session has read third-party messages, so it cannot apply skills. The revision stays proposed: apply it on the Skills screen, or from a session that has not read third-party messages.",
        grant: "skill.apply",
      });
      const after = (await (
        await get(arranged.harness.base, "/api/v1/skills/teach", arranged.token)
      ).json()) as SkillDetail;
      expect(after.skill).toMatchObject({ currentRevisionHash: null, proposedCount: 1 });
    });
  });

  it("refuses the proposal past the cap of proposed revisions", async () => {
    await withPipeline(async (arranged) => {
      const ada = await spawnThreadWithGrants(arranged, "ada", ["skill.read", "skill.write"]);
      for (let index = 0; index < MAX_PROPOSED_SKILL_REVISIONS; index += 1) {
        await readProposed(await propose(arranged, ada.token, "teach", `Body ${String(index)}`));
      }
      const response = await propose(arranged, ada.token, "teach", "One too many");
      expect(response.status).toBe(422);
      const refusal = await readRefusal(response);
      expect(refusal.code).toBe("cap_exceeded");
      expect(refusal.message).toContain(
        "20 proposed revisions already wait for review, in `teach`.",
      );
    });
  });
});
