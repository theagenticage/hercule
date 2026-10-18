/**
 * Test helpers for the skills folders: Skill Revisions built in memory, and a
 * stub controller that serves their archives.
 *
 * The stub is `Bun.serve`, because the runner must not import controller
 * code. It records every request, so a test can count the fetches.
 */
import * as Effect from "effect/Effect";
import {
  RUNNER_SKILL_REVISIONS_PATH,
  buildSkillArchive,
  computeSkillRevisionHash,
  type SessionSkill,
  type SkillFile,
} from "@hercule/protocol";

/** A Skill Revision as the controller holds it: its hash and its archive. */
export interface TestSkillRevision {
  readonly revisionHash: string;
  readonly archive: Uint8Array;
  readonly files: ReadonlyArray<SkillFile>;
}

/** Builds a Skill Revision from text files. A path ending in `.sh` gets mode `755`, any other `644`. */
export const buildTestSkillRevision = (
  files: Readonly<Record<string, string>>,
): Promise<TestSkillRevision> => {
  const skillFiles: ReadonlyArray<SkillFile> = Object.entries(files).map(([path, text]) => ({
    path,
    mode: path.endsWith(".sh") ? "755" : "644",
    content: new TextEncoder().encode(text),
  }));
  return Effect.runPromise(
    Effect.gen(function* () {
      return {
        revisionHash: yield* computeSkillRevisionHash(skillFiles),
        archive: yield* buildSkillArchive(skillFiles),
        files: skillFiles,
      };
    }),
  );
};

/** Returns the entry a start frame names a revision under. */
export const buildTestSessionSkill = (name: string, revision: TestSkillRevision): SessionSkill => ({
  name,
  revisionHash: revision.revisionHash,
});

/** A stub controller serving Skill Revisions. */
export interface SkillControllerStub {
  readonly url: string;
  /** The revision hashes requested so far, in order, one entry per request. */
  readonly requested: Array<string>;
  /** The authorization header of each request, in order. */
  readonly authorizations: Array<string | null>;
  /** When set, a request waits for this promise before it responds. */
  delayResponsesUntil: Promise<void> | undefined;
  /** Stops the server. */
  readonly stop: () => void;
}

/**
 * Starts a stub controller that serves, for each revision hash it knows,
 * either those bytes or the response the function builds, and an error
 * envelope with HTTP 404 for any other hash.
 */
export const startSkillController = (
  revisions: Readonly<Record<string, Uint8Array | (() => Response)>>,
): SkillControllerStub => {
  const stub = {
    url: "",
    requested: [] as Array<string>,
    authorizations: [] as Array<string | null>,
    delayResponsesUntil: undefined as Promise<void> | undefined,
  };
  // Bound to the address the store is given, so another process listening on
  // the same port number at another address can never answer instead.
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      const hash = new URL(request.url).pathname.replace(`${RUNNER_SKILL_REVISIONS_PATH}/`, "");
      stub.requested.push(hash);
      stub.authorizations.push(request.headers.get("authorization"));
      if (stub.delayResponsesUntil !== undefined) await stub.delayResponsesUntil;
      const body = revisions[hash];
      if (body === undefined) {
        return Response.json(
          { error: { code: "not_found", message: "No applied Skill Revision has this hash." } },
          { status: 404 },
        );
      }
      return typeof body === "function" ? body() : new Response(body);
    },
  });
  return Object.assign(stub, {
    url: `http://127.0.0.1:${String(server.port)}`,
    stop: () => void server.stop(true),
  });
};
