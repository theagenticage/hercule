/**
 * The HTTP route a runner fetches a Skill Revision's archive from:
 * `GET RUNNER_SKILL_REVISIONS_PATH/:revisionHash`. A start frame names each
 * library skill of a session only by its revision hash, so the runner fetches
 * the archive here before it starts the harness (spec 03 section 2.2).
 *
 * Like the runner socket, the route is not in the derived operation table:
 * the caller presents a runner's credential, which no operation accepts and
 * no grant applies to. Any runner may fetch any revision that has been
 * applied; every other hash gets `404`.
 */
import * as Effect from "effect/Effect";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { RUNNER_SKILL_REVISIONS_PATH } from "@hercule/protocol";
import { SkillService } from "../skills";
import { respondToRunner } from "./respond-to-runner";

/**
 * The fetch. It answers the archive's bytes whole, at most `MAX_SKILL_BYTES`,
 * read under the Skill Library lock so a delete cannot remove the file
 * halfway through. The derived routes get their span from the router
 * middleware, which this route sits outside of, so it opens its own.
 *
 * - `cache-control: private, no-store` keeps a shared cache from storing a
 *   file only a runner may read.
 * - `x-content-type-options: nosniff` stops a browser from guessing another
 *   type from the bytes.
 */
export const RunnerSkillRevisionRouteLayer = HttpRouter.add(
  "GET",
  `${RUNNER_SKILL_REVISIONS_PATH}/:revisionHash`,
  (request) =>
    respondToRunner(request, "fetching a Skill Revision", () =>
      Effect.gen(function* () {
        const { revisionHash } = yield* HttpRouter.params;
        const archive = yield* (yield* SkillService).readAppliedRevisionArchive(revisionHash ?? "");
        return HttpServerResponse.uint8Array(archive, {
          contentType: "application/x-tar",
          headers: {
            "cache-control": "private, no-store",
            "x-content-type-options": "nosniff",
          },
        });
      }),
    ).pipe(Effect.withSpan("runner.skillRevision.fetch")),
);
