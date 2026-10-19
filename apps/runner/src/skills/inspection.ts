/**
 * Answers the controller's questions which repository skills a workspace
 * offers, and which a workspace that does not exist yet would offer (spec 06
 * section 9.4).
 */
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Semaphore from "effect/Semaphore";
import {
  MAX_MESSAGE_LENGTH,
  type RepositorySkillsInspection,
  type RepositorySkillsPreview,
} from "@hercule/protocol";
import { describeCause } from "../report";
import type { Workspaces } from "../workspaces";
import {
  listRepositorySkills,
  listWorkspaceRepositorySkills,
  type CheckoutToList,
  type RepositorySkillListing,
} from "./repository";

/**
 * How long one inspection or preview may take, from the request to the answer,
 * including the wait for a place to read. It is a second shorter than the 10
 * seconds the controller waits for the answer, so the runner answers `failed`
 * with a reason before the controller gives up with a vaguer one.
 */
const LISTING_TIMEOUT: Duration.Duration = Duration.seconds(9);

/** The most inspections and previews the runner reads at the same time, whoever asks. */
const MAX_PARALLEL_LISTINGS = 4;

/**
 * Held by every inspection and preview while it reads, until its file system
 * calls have really stopped. A listing that takes too long is aborted and
 * answered at `LISTING_TIMEOUT`, but it keeps its place until the last call it
 * made returns, so listings that hang on a stalled disk cannot pile up beyond
 * this limit. Each one walks the files of up to 32 checkouts, and controllers
 * and clients ask often, so the limit keeps a burst of requests from using the
 * runner's disk for the sessions it hosts. One semaphore serves all requests,
 * not one per request.
 */
const listings = Semaphore.makeUnsafe(MAX_PARALLEL_LISTINGS);

const SLOW_LISTING = `listing the workspace's repository skills took longer than ${String(Duration.toSeconds(LISTING_TIMEOUT))} seconds`;

const BUSY_RUNNER = `the runner is still busy listing repository skills for earlier requests; try again in a moment`;

/**
 * Builds the answer to a request from the listing it ran, ready to send to
 * the controller: the skills without their absolute paths, which stay on the
 * runner, and the skipped folders. Never fails: a failure that is a message
 * becomes the `failed` outcome with that message for the user, and so does an
 * unexpected error.
 *
 * The listing runs in a fiber of its own, in a place of `listings`. If it has
 * not finished after `LISTING_TIMEOUT`, counted from the request, the answer
 * is `failed` and the fiber is interrupted in the background: the listing
 * aborts, and gives its place back only when it has stopped. The failure says
 * whether the listing was reading (`SLOW_LISTING`) or still waiting for a
 * place (`BUSY_RUNNER`), in which case nothing was read.
 */
const buildOutcome = (
  listing: Effect.Effect<RepositorySkillListing, string>,
): Effect.Effect<RepositorySkillsInspection["outcome"]> =>
  Effect.gen(function* () {
    let hasStarted = false;
    const fiber = yield* Effect.forkDetach(
      listings.withPermits(1)(
        Effect.suspend(() => {
          hasStarted = true;
          return listing;
        }),
      ),
    );
    return yield* Fiber.join(fiber).pipe(
      Effect.timeoutOrElse({
        duration: LISTING_TIMEOUT,
        orElse: () => Effect.fail(hasStarted ? SLOW_LISTING : BUSY_RUNNER),
      }),
      // Also runs when the request itself is interrupted. Joining a fiber does not stop it.
      Effect.ensuring(Effect.asVoid(Effect.forkDetach(Fiber.interrupt(fiber)))),
    );
  }).pipe(
    Effect.map((read): RepositorySkillsInspection["outcome"] => ({
      status: "listed",
      skills: read.skills.map(({ checkoutName, name, description, path }) => ({
        checkoutName,
        name,
        description,
        path,
      })),
      skipped: read.skipped,
      truncated: read.truncated,
    })),
    // A failure is already a sentence for the user. Only a defect needs describing.
    Effect.catch((message: string) =>
      Effect.succeed({
        status: "failed" as const,
        message: message.slice(0, MAX_MESSAGE_LENGTH),
      }),
    ),
    Effect.catchCause((cause) =>
      Effect.succeed({
        status: "failed" as const,
        message: describeCause(cause, MAX_MESSAGE_LENGTH),
      }),
    ),
  );

/**
 * Returns what the workspace offers, ready to send to the controller. Never
 * fails: a workspace this runner does not have, a workspace folder that
 * cannot be read, or an unexpected error becomes the `failed` outcome.
 */
export const inspectRepositorySkills = (
  workspaces: Pick<Workspaces, "resolve">,
  workspaceId: string,
): Effect.Effect<RepositorySkillsInspection["outcome"]> =>
  buildOutcome(
    Effect.gen(function* () {
      const workspace = yield* workspaces.resolve(workspaceId);
      if (workspace === undefined) {
        return yield* Effect.fail(`The runner has no workspace \`${workspaceId}\`.`);
      }
      return yield* listWorkspaceRepositorySkills(workspace);
    }),
  );

/**
 * Returns what a workspace of the given checkouts would offer, ready to send
 * to the controller. Each checkout is read from its repo's main workspace on
 * this runner. A checkout whose workspace this runner does not have, or that
 * has no workspace, is listed as skipped by the listing. Never fails: an
 * unexpected error becomes the `failed` outcome.
 */
export const previewRepositorySkills = (
  workspaces: Pick<Workspaces, "resolve">,
  checkouts: RepositorySkillsPreview["checkouts"],
): Effect.Effect<RepositorySkillsInspection["outcome"]> =>
  buildOutcome(
    Effect.forEach(checkouts, ({ remote, subdirectory, workspaceId }) =>
      Effect.gen(function* () {
        const workspace = workspaceId === null ? undefined : yield* workspaces.resolve(workspaceId);
        // A main workspace is one repo: its only checkout is the folder to read.
        const only = workspace?.checkouts.length === 1 ? workspace.checkouts[0] : undefined;
        return { remote, subdirectory, path: only?.path ?? null } satisfies CheckoutToList;
      }),
    ).pipe(Effect.flatMap(listRepositorySkills)),
  );
