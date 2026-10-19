/**
 * Answers the controller's questions which repository skills a workspace
 * offers, and which a workspace that does not exist yet would offer (spec 06
 * section 9.4).
 */
import * as Effect from "effect/Effect";
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

/** The most inspections and previews the runner reads at the same time, whoever asks. */
const MAX_PARALLEL_LISTINGS = 4;

/**
 * Held by every inspection and preview while it reads. Each one walks the
 * files of up to 32 checkouts, and controllers and clients ask often, so the
 * limit keeps a burst of requests from using the runner's disk for the
 * sessions it hosts. One semaphore serves all requests, not one per request.
 */
const listings = Semaphore.makeUnsafe(MAX_PARALLEL_LISTINGS);

/**
 * Builds the answer to a request from the listing it ran, ready to send to
 * the controller: the skills without their absolute paths, which stay on the
 * runner, and the skipped folders. Never fails: a failure that is a message
 * becomes the `failed` outcome with that message for the user, and so does an
 * unexpected error.
 */
const buildOutcome = (
  listing: Effect.Effect<RepositorySkillListing, string>,
): Effect.Effect<RepositorySkillsInspection["outcome"]> =>
  listings
    .withPermits(1)(listing)
    .pipe(
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
