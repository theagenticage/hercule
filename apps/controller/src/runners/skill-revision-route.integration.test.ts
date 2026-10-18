/**
 * The route a runner fetches a Skill Revision's archive from, through the
 * whole HTTP stack: the runner credential, the applied-revision check, the
 * bytes and headers of the answer, and the promotion gate.
 */
import { copyFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import { RUNNER_SKILL_REVISIONS_PATH, type JoinAnswer } from "@hercule/protocol";
import {
  completeSetup,
  readErrorBody,
  send,
  withServer,
  type ServerHarness,
} from "../http/testing";
import { freezeController, sealController } from "../promotion/testing";
import { buildTestSkillArchive, importTestSkill } from "../skills/testing";

/** Joins a runner and returns its credential. The route checks only the credential, so the runner never connects. */
const joinRunner = async (harness: ServerHarness): Promise<string> => {
  const joined = await send("POST", harness.base, "/api/v1/runners/join", {
    body: {},
    token: await harness.joinToken(),
  });
  expect(joined.status, await joined.clone().text()).toBe(201);
  return ((await joined.json()) as JoinAnswer).credential;
};

/** Fetches a Skill Revision the way a runner does, with `credential` as its bearer, or none. */
const fetchRevision = (base: string, hash: string, credential?: string): Promise<Response> =>
  fetch(`${base}${RUNNER_SKILL_REVISIONS_PATH}/${hash}`, {
    headers: credential === undefined ? {} : { authorization: `Bearer ${credential}` },
  });

/** Returns the path of a revision's archive in the harness's Data Root. */
const buildArchivePath = (harness: ServerHarness, hash: string): string =>
  join(harness.home, "data", "skills", `${hash}.tar`);

describe("GET RUNNER_SKILL_REVISIONS_PATH/:revisionHash", () => {
  it("answers the archive's exact bytes, with headers that keep it private and untyped by guessing", async () => {
    await withServer(async (harness) => {
      const user = await completeSetup(harness.base);
      const credential = await joinRunner(harness);
      const skill = await importTestSkill(harness.base, user, "teach");

      const fetched = await fetchRevision(harness.base, skill.currentRevisionHash!, credential);

      expect(fetched.status, await fetched.clone().text()).toBe(200);
      expect(fetched.headers.get("content-type")).toBe("application/x-tar");
      expect(fetched.headers.get("cache-control")).toBe("private, no-store");
      expect(fetched.headers.get("x-content-type-options")).toBe("nosniff");
      expect(new Uint8Array(await fetched.arrayBuffer())).toEqual(
        await buildTestSkillArchive("teach"),
      );
    });
  });

  it("still answers a revision that was current before a newer one replaced it", async () => {
    await withServer(async (harness) => {
      const user = await completeSetup(harness.base);
      const credential = await joinRunner(harness);
      const first = await importTestSkill(harness.base, user, "teach");
      const second = await importTestSkill(harness.base, user, "teach", {
        body: "Revised",
        replace: true,
      });
      expect(second.currentRevisionHash).not.toBe(first.currentRevisionHash);

      const fetched = await fetchRevision(harness.base, first.currentRevisionHash!, credential);

      expect(fetched.status, await fetched.clone().text()).toBe(200);
      expect(new Uint8Array(await fetched.arrayBuffer())).toEqual(
        await buildTestSkillArchive("teach"),
      );
    });
  });

  it("answers 401 without a credential, with one no runner holds, and with a user's token", async () => {
    await withServer(async (harness) => {
      const user = await completeSetup(harness.base);
      await joinRunner(harness);
      const hash = (await importTestSkill(harness.base, user, "teach")).currentRevisionHash!;

      for (const credential of [undefined, "a-made-up-credential", user]) {
        const fetched = await fetchRevision(harness.base, hash, credential);
        expect(fetched.status, String(credential)).toBe(401);
        expect((await readErrorBody(fetched)).code).toBe("unauthenticated");
      }
    });
  });

  it("answers 404 for a malformed hash, an unknown hash, a revision never applied, and a missing archive", async () => {
    await withServer(async (harness) => {
      const user = await completeSetup(harness.base);
      const credential = await joinRunner(harness);
      const hash = (await importTestSkill(harness.base, user, "teach")).currentRevisionHash!;
      // A proposed revision with an archive on disk: only the row's missing
      // `applied_at` keeps a runner from fetching it.
      const proposed = "d".repeat(64);
      await Effect.runPromise(
        Effect.orDie(
          harness.sql`
            INSERT INTO skill_revisions (skill_id, hash, origin, file_count, size_bytes,
              description, created_at, created_by)
            SELECT id, ${proposed}, 'session', 1, 10, 'Teaches.', created_at, created_by
            FROM skills WHERE name = 'teach'`,
        ),
      );
      copyFileSync(buildArchivePath(harness, hash), buildArchivePath(harness, proposed));

      for (const unknown of ["not-a-hash", hash.toUpperCase(), "e".repeat(64), proposed]) {
        const fetched = await fetchRevision(harness.base, unknown, credential);
        expect(fetched.status, unknown).toBe(404);
        expect((await readErrorBody(fetched)).code).toBe("not_found");
      }

      // An applied revision whose archive is gone, as after a backup restored
      // without its `skills/` folder.
      rmSync(buildArchivePath(harness, hash));
      const missing = await fetchRevision(harness.base, hash, credential);
      expect(missing.status).toBe(404);
      expect((await readErrorBody(missing)).code).toBe("not_found");
    });
  });

  it("answers while a promotion freezes the controller, and refuses once it is sealed", async () => {
    await withServer(async (harness) => {
      const user = await completeSetup(harness.base);
      const credential = await joinRunner(harness);
      const hash = (await importTestSkill(harness.base, user, "teach")).currentRevisionHash!;

      // A fetch writes nothing, so a freeze lets it through like any read.
      const promotionToken = await freezeController(harness.base, user);
      expect((await fetchRevision(harness.base, hash, credential)).status).toBe(200);

      await sealController(harness.base, promotionToken);
      const sealed = await fetchRevision(harness.base, hash, credential);
      expect(sealed.status).toBe(503);
      expect((await readErrorBody(sealed)).code).toBe("controller_sealed");
    });
  });
});
